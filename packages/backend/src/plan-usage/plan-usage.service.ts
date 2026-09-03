import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../entities/agent-message.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import { ProviderQuotaReport, ProviderUsageAdapterRegistry } from './provider-usage-adapters';

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_PROBES = 4;

interface MetricRow {
  tenant_provider_id: string;
  requests: string | number | null;
  tokens: string | number | null;
  cost: string | number | null;
  attempts: string | number | null;
  succeeded: string | number | null;
  last_used_at: Date | string | null;
}

export interface ObservedPlanUsage {
  requests: number;
  tokens: number;
  estimated_cost_usd: number;
  attempts: number;
  succeeded: number;
  success_rate: number | null;
  last_used_at: string | null;
}

export interface PlanUsageQuota extends ProviderQuotaReport {
  stale?: boolean;
}

export interface PlanUsageRow {
  tenant_provider_id: string;
  provider: string;
  auth_type: string;
  label: string;
  is_active: boolean;
  connected_at: string;
  observed_30d: ObservedPlanUsage;
  quota: PlanUsageQuota;
  /**
   * Operator-configured manual allowance, independent of which quota is
   * currently effective. The UI needs this even when live/cached provider
   * data is authoritative, so a stored limit stays visible and clearable.
   */
  manual_usage_limit_usd: number | null;
}

interface CacheEntry {
  report: ProviderQuotaReport;
  cachedAt: number;
}

const METRICS_SQL = `
  SELECT
    at.tenant_provider_id,
    COUNT(DISTINCT COALESCE(at.request_id, at.id)) FILTER (
      WHERE at.status IS NULL
        OR (at.status NOT IN ('pending', 'cancelled') AND at.status NOT IN ('error', 'fallback_error', 'rate_limited', 'auto_fixed', 'failed'))
    ) AS requests,
    SUM(COALESCE(at.input_tokens, 0) + COALESCE(at.output_tokens, 0))
      FILTER (WHERE at.status IS NULL OR at.status NOT IN ('pending', 'cancelled')) AS tokens,
    SUM(CASE WHEN at.cost_usd >= 0 THEN at.cost_usd ELSE NULL END)
      FILTER (WHERE at.status IS NULL OR at.status NOT IN ('pending', 'cancelled')) AS cost,
    COUNT(*) FILTER (WHERE at.status IS NULL OR at.status NOT IN ('pending', 'cancelled')) AS attempts,
    COUNT(*) FILTER (WHERE at.status IS NULL OR at.status IN ('ok', 'success')) AS succeeded,
    MAX(at.timestamp) FILTER (WHERE at.status IS NULL OR at.status NOT IN ('pending', 'cancelled')) AS last_used_at
  FROM agent_messages at
  WHERE at.tenant_id = $1
    AND at.tenant_provider_id = ANY($2::varchar[])
    AND at.timestamp >= NOW() - INTERVAL '30 days'
    AND NOT EXISTS (
      SELECT 1 FROM agents playag
      WHERE playag.tenant_id = at.tenant_id
        AND playag.is_playground = true
        AND (playag.id = at.agent_id OR playag.name = at.agent_name)
    )
  GROUP BY at.tenant_provider_id
`;

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function emptyObserved(): ObservedPlanUsage {
  return {
    requests: 0,
    tokens: 0,
    estimated_cost_usd: 0,
    attempts: 0,
    succeeded: 0,
    success_rate: null,
    last_used_at: null,
  };
}

/** Copy only the public normalized contract, dropping arbitrary adapter fields. */
function publicReport(report: ProviderQuotaReport): ProviderQuotaReport {
  return {
    status: report.status,
    source: report.source,
    fetchedAt: report.fetchedAt,
    windows: report.windows,
    ...(report.planName !== undefined ? { planName: report.planName } : {}),
    ...(report.balance !== undefined ? { balance: report.balance } : {}),
    ...(report.overage !== undefined ? { overage: report.overage } : {}),
    ...(report.message !== undefined ? { message: report.message } : {}),
  };
}

@Injectable()
export class PlanUsageService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    private readonly providerKeys: ProviderKeyService,
    private readonly adapters: ProviderUsageAdapterRegistry,
  ) {}

  async getPlanUsage(
    tenantId: string | null,
    refreshConnectionId?: string,
  ): Promise<PlanUsageRow[]> {
    if (!tenantId) return [];

    // Deliberately exact-tenant only. Shared/borrowed credentials are never
    // selected, decrypted, or probed by this endpoint.
    const found = await this.providerRepo.find({
      where: { tenant_id: tenantId },
      order: { priority: 'ASC', id: 'ASC' },
    });
    const owned = found.filter(
      (connection) => connection.tenant_id === tenantId && connection.auth_type !== 'local',
    );
    const connections = refreshConnectionId
      ? owned.filter((connection) => connection.id === refreshConnectionId)
      : owned;
    if (refreshConnectionId && connections.length === 0) {
      throw new NotFoundException('Provider connection not found');
    }
    if (connections.length === 0) return [];

    const metricRows = (await this.messageRepo.query(METRICS_SQL, [
      tenantId,
      connections.map((connection) => connection.id),
    ])) as MetricRow[];
    const metricById = new Map(metricRows.map((row) => [row.tenant_provider_id, row]));

    const rows = await this.mapConcurrent(
      connections,
      MAX_CONCURRENT_PROBES,
      async (connection) => {
        const metric = metricById.get(connection.id);
        const attempts = numberValue(metric?.attempts);
        const succeeded = numberValue(metric?.succeeded);
        const observed = metric
          ? {
              requests: numberValue(metric.requests),
              tokens: numberValue(metric.tokens),
              estimated_cost_usd: numberValue(metric.cost),
              attempts,
              succeeded,
              success_rate: attempts > 0 ? (succeeded / attempts) * 100 : null,
              last_used_at: iso(metric.last_used_at),
            }
          : emptyObserved();
        const automaticQuota = await this.quotaFor(
          tenantId,
          connection,
          Boolean(refreshConnectionId),
        );
        const quota =
          connection.auth_type === 'api_key' &&
          connection.manual_usage_limit_usd != null &&
          (automaticQuota.status === 'unsupported' || automaticQuota.status === 'unavailable')
            ? this.manualQuota(connection.manual_usage_limit_usd, observed.estimated_cost_usd)
            : automaticQuota;
        return {
          tenant_provider_id: connection.id,
          provider: connection.provider,
          auth_type: connection.auth_type,
          label: connection.label,
          is_active: connection.is_active,
          connected_at: connection.connected_at,
          observed_30d: observed,
          quota,
          manual_usage_limit_usd:
            connection.manual_usage_limit_usd != null
              ? Number(connection.manual_usage_limit_usd)
              : null,
        };
      },
    );

    return rows;
  }

  async setManualLimit(
    tenantId: string | null,
    connectionId: string,
    limitUsd: number | null,
  ): Promise<TenantProvider> {
    if (!tenantId) throw new NotFoundException('Provider connection not found');
    const connection = await this.providerRepo.findOne({
      where: { id: connectionId, tenant_id: tenantId },
    });
    if (!connection) throw new NotFoundException('Provider connection not found');
    if (connection.auth_type !== 'api_key') {
      throw new BadRequestException(
        'Manual allowances are only available for usage-based API keys',
      );
    }
    if (
      limitUsd !== null &&
      (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 999999999999)
    ) {
      throw new BadRequestException('Manual allowance must be greater than zero');
    }

    connection.manual_usage_limit_usd = limitUsd === null ? null : limitUsd.toFixed(2);
    connection.updated_at = new Date().toISOString();
    this.cache.delete(`${tenantId}:${connection.id}`);
    return this.providerRepo.save(connection);
  }

  private manualQuota(rawLimit: string, observedCostUsd: number): PlanUsageQuota {
    const limit = numberValue(rawLimit);
    const used = Math.max(0, observedCostUsd);
    const remaining = Math.max(0, limit - used);
    const usedPercent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
    return {
      status: 'manual',
      source: 'manual_30d_allowance',
      fetchedAt: new Date().toISOString(),
      windows: [
        {
          name: 'Manual 30-day allowance',
          limit,
          used,
          remaining,
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          unit: 'USD',
        },
      ],
      balance: { limit, used, remaining, unit: 'USD' },
      message: 'Calculated from your manual allowance and Manifest-tracked cost over 30 days',
    };
  }

  private async quotaFor(
    tenantId: string,
    connection: TenantProvider,
    forceRefresh: boolean,
  ): Promise<PlanUsageQuota> {
    const key = `${tenantId}:${connection.id}`;
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return { ...publicReport(cached.report), status: 'cached' };
    }

    const probed = publicReport(
      await this.adapters.probe(connection, () =>
        this.providerKeys.getOwnedProviderCredentialById(tenantId, connection.id),
      ),
    );
    if (probed.status === 'live') {
      this.cache.set(key, { report: probed, cachedAt: Date.now() });
      return probed;
    }
    if (cached) {
      return {
        ...publicReport(cached.report),
        status: 'cached',
        stale: true,
        ...(probed.message ? { message: probed.message } : {}),
      };
    }
    return probed;
  }

  private async mapConcurrent<T, R>(
    values: T[],
    limit: number,
    mapper: (value: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }
}
