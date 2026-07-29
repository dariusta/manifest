import { Controller, Get, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { TenantCacheService } from '../common/services/tenant-cache.service';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import { CustomProviderService } from './custom-provider/custom-provider.service';
import { filterProvidersForDeployment } from '../common/utils/provider-availability';

/**
 * Tenant-level provider management endpoints.
 * Returns all providers for the tenant (not scoped to a specific agent).
 *
 * CONFIG ONLY. This endpoint must stay cheap: it reads `tenant_providers`
 * (small) plus the in-memory pricing cache, and never touches `agent_messages`.
 * Usage stats (consumption_*, last_used_at, sparkline_7d) moved to
 * `GET /api/v1/providers/usage` (ProviderUsageController) so a config read no
 * longer triggers two multi-second scans over the 8GB messages table. The
 * frontend fetches the two halves independently and merges by
 * (provider, auth_type).
 */
@Controller('api/v1/providers')
export class TenantProvidersController {
  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly customProviderService: CustomProviderService,
    // Optional + last so positional test constructions keep working; Nest
    // injects the global TenantCacheService in production.
    @Optional() private readonly tenantCache: TenantCacheService | null = null,
  ) {}

  /**
   * List all tenant-level providers (config only). Groups by
   * (provider, auth_type) and returns the connected keys, model counts, and
   * display names. No usage aggregation — see ProviderUsageController.
   */
  @Get()
  async listProviders(@TenantCtx() ctx: TenantContext) {
    const tenantId = ctx.tenantId;
    // Include providers borrowed from team workspaces this workspace shares with,
    // tagged read-only for the UI (mutations reject foreign tenant_ids anyway).
    const borrowedTenantIds =
      tenantId && this.tenantCache ? await this.tenantCache.sharedProviderTenantIds(tenantId) : [];
    const providers = filterProvidersForDeployment(
      !tenantId
        ? []
        : borrowedTenantIds.length
          ? await this.providerRepo.find({
              where: { tenant_id: In([tenantId, ...borrowedTenantIds]) },
            })
          : await this.providerRepo.find({ where: { tenant_id: tenantId } }),
    );
    // Display names for borrowed workspaces (only ones the caller belongs to).
    const workspaceNames = new Map<string, string>();
    if (borrowedTenantIds.length && ctx.userId && this.tenantCache) {
      for (const ws of await this.tenantCache.listForUser(ctx.userId)) {
        workspaceNames.set(ws.id, ws.name);
      }
    }
    const connectionOf = (p: TenantProvider) => {
      const shared = tenantId != null && p.tenant_id !== tenantId;
      return {
        id: p.id,
        label: p.label,
        key_prefix: p.key_prefix,
        priority: p.priority,
        connected_at: p.connected_at,
        models_fetched_at: p.models_fetched_at,
        cached_model_count: Array.isArray(p.cached_models) ? p.cached_models.length : 0,
        is_active: p.is_active,
        shared,
        shared_from: shared ? (workspaceNames.get(p.tenant_id) ?? null) : null,
      };
    };

    // Group providers and build response
    const grouped = new Map<
      string,
      {
        provider: string;
        auth_type: string;
        connections: Array<{
          id: string;
          label: string;
          key_prefix: string | null;
          priority: number;
          connected_at: string;
          models_fetched_at: string | null;
          cached_model_count: number;
          is_active: boolean;
          shared: boolean;
          shared_from: string | null;
        }>;
        total_models: number;
      }
    >();

    for (const p of providers) {
      const key = `${p.provider}::${p.auth_type}`;
      const existing = grouped.get(key);
      const modelCount = Array.isArray(p.cached_models) ? p.cached_models.length : 0;

      if (existing) {
        existing.connections.push(connectionOf(p));
        existing.total_models = Math.max(existing.total_models, modelCount);
      } else {
        grouped.set(key, {
          provider: p.provider,
          auth_type: p.auth_type,
          connections: [connectionOf(p)],
          total_models: modelCount,
        });
      }
    }

    // Resolve custom provider display names (provider key = `custom:<uuid>`).
    const customProviders = tenantId ? await this.customProviderService.list(tenantId) : [];
    const customNameById = new Map(customProviders.map((cp) => [cp.id, cp.name]));

    const result = Array.from(grouped.values()).map((g) => ({
      provider: g.provider,
      auth_type: g.auth_type,
      display_name: g.provider.startsWith('custom:')
        ? (customNameById.get(g.provider.slice('custom:'.length)) ?? null)
        : null,
      connection_count: g.connections.length,
      connections: g.connections,
      total_models: g.total_models,
    }));

    // Count models per provider from the global pricing cache (covers all providers, connected or not)
    const allPricing = this.pricingCache.getAll();
    const modelCountByProvider = new Map<string, number>();
    for (const entry of allPricing) {
      const prov = entry.provider?.toLowerCase();
      if (prov) {
        modelCountByProvider.set(prov, (modelCountByProvider.get(prov) ?? 0) + 1);
      }
    }

    return {
      providers: result,
      model_counts: Object.fromEntries(modelCountByProvider),
    };
  }
}
