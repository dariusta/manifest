import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import { RoutingPresetEntity } from '../../entities/routing-preset.entity';
import { Agent } from '../../entities/agent.entity';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { HeaderTier } from '../../entities/header-tier.entity';
import { AgentModelParams } from '../../entities/agent-model-params.entity';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { TenantCacheService } from '../../common/services/tenant-cache.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { RoutingCacheService } from '../routing-core/routing-cache.service';
import { assertStreamableResponseMode } from '../routing-core/response-mode-guard';
import { parsePresetConfig } from './routing-preset.schema';
import { toLocalSqlTimestamp } from '../../common/utils/postgres-sql';
import type { ModelRoute, PresetChain, RoutingPresetConfig } from 'manifest-shared';

@Injectable()
export class RoutingPresetService {
  constructor(
    private readonly db: DataSource,
    private readonly models: ModelDiscoveryService,
    private readonly routingCache: RoutingCacheService,
    private readonly tenants: TenantCacheService,
  ) {}

  async list(tenantId: string | null) {
    if (!tenantId) return [];
    return this.db
      .getRepository(RoutingPresetEntity)
      .find({ where: { tenant_id: tenantId }, order: { name: 'ASC' } });
  }
  private async owned(tenantId: string | null, id: string) {
    const preset = tenantId
      ? await this.db.getRepository(RoutingPresetEntity).findOneBy({ id, tenant_id: tenantId })
      : null;
    if (!preset) throw new NotFoundException('Routing preset not found');
    return preset;
  }
  private async agent(manager: EntityManager, tenantId: string | null, name: string) {
    const agent = tenantId
      ? await manager.findOneBy(Agent, {
          tenant_id: tenantId,
          name,
          deleted_at: IsNull(),
          is_playground: false,
        })
      : null;
    if (!agent) throw new NotFoundException('Harness not found');
    return agent;
  }
  private name(value: string): string {
    const name = value.trim();
    if (!name || name.length > 80)
      throw new BadRequestException('Preset name must contain 1–80 characters');
    return name;
  }
  private async save(preset: RoutingPresetEntity) {
    try {
      return await this.db.getRepository(RoutingPresetEntity).save(preset);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A preset with this name already exists');
      throw error;
    }
  }
  async create(tenantId: string | null, name: string, sourceAgentName: string) {
    // Read all routing tables from one snapshot, including concurrent edits.
    const snapshot = await this.db.transaction('REPEATABLE READ', async (manager) => {
      const source = await this.agent(manager, tenantId, sourceAgentName);
      const tiers = await manager.findBy(TierAssignment, { agent_id: source.id });
      const specificity = await manager.findBy(SpecificityAssignment, { agent_id: source.id });
      const headers = await manager.findBy(HeaderTier, { agent_id: source.id });
      const params = await manager.findBy(AgentModelParams, { agent_id: source.id });
      const providers = await manager.findBy(AgentEnabledProvider, { agent_id: source.id });
      return { source, tiers, specificity, headers, params, providers };
    });
    const { source, tiers, specificity, headers, params, providers } = snapshot;
    const chain = (row: {
      override_route: ModelRoute | null;
      auto_assigned_route?: ModelRoute | null;
      fallback_routes: ModelRoute[] | null;
      response_mode: string;
      output_modality: string;
    }) => ({
      route: row.override_route ?? row.auto_assigned_route ?? null,
      fallbacks: row.fallback_routes ?? [],
      responseMode: row.response_mode,
      outputModality: row.output_modality,
    });
    const config = parsePresetConfig({
      version: 1,
      complexityRoutingEnabled: source.complexity_routing_enabled,
      providerIds: providers.map((p) => p.tenant_provider_id),
      tiers: tiers.map((row) => ({ ...chain(row), tier: row.tier })),
      specificity: specificity.map((row) => ({
        ...chain(row),
        category: row.category,
        active: row.is_active,
      })),
      headers: headers.map((row) => ({
        ...chain(row),
        sourceId: row.id,
        name: row.name,
        headerKey: row.header_key,
        headerValue: row.header_value,
        badgeColor: row.badge_color,
        sortOrder: row.sort_order,
        enabled: row.enabled,
      })),
      modelParams: params.map((row) => ({
        scope: row.scope_key,
        provider: row.provider,
        authType: row.auth_type,
        model: row.model_name,
        params: row.params,
      })),
    });
    const now = toLocalSqlTimestamp();
    return this.save(
      Object.assign(new RoutingPresetEntity(), {
        id: randomUUID(),
        tenant_id: source.tenant_id,
        name: this.name(name),
        config,
        created_at: now,
        updated_at: now,
      }),
    );
  }
  async update(tenantId: string | null, id: string, body: { name?: string; config?: unknown }) {
    const preset = await this.owned(tenantId, id);
    if (body.name !== undefined) preset.name = this.name(body.name);
    if (body.config !== undefined) preset.config = parsePresetConfig(body.config);
    preset.updated_at = toLocalSqlTimestamp();
    return this.save(preset);
  }
  async delete(tenantId: string | null, id: string) {
    const preset = await this.owned(tenantId, id);
    await this.db
      .getRepository(RoutingPresetEntity)
      .delete({ id: preset.id, tenant_id: preset.tenant_id });
    return { ok: true };
  }
  async apply(tenantId: string | null, id: string, agentName: string) {
    const preset = await this.owned(tenantId, id);
    const target = await this.agent(this.db.manager, tenantId, agentName);
    const config = parsePresetConfig(preset.config);
    const available = await this.models.getModelsForAgent(preset.tenant_id);
    const chains = [...config.tiers, ...config.specificity, ...config.headers];
    const routes = chains.flatMap((t) => [...(t.route ? [t.route] : []), ...t.fallbacks]);
    const missing = routes.filter(
      (route) =>
        !available.some(
          (model) =>
            model.id === route.model &&
            model.provider.toLowerCase() === route.provider.toLowerCase() &&
            (model.authType ?? 'api_key') === route.authType,
        ),
    );
    if (missing.length)
      throw new BadRequestException(
        `Connect or refresh the providers for: ${[...new Set(missing.map((m) => m.model))].join(', ')}`,
      );
    for (const tier of chains)
      assertStreamableResponseMode(tier.responseMode, 'preset', tier.route, tier.fallbacks);
    const allowedTenants = new Set([
      preset.tenant_id,
      ...(await this.tenants.sharedProviderTenantIds(preset.tenant_id)),
    ]);
    const usable = await this.db.getRepository(TenantProvider).find({
      where: { tenant_id: In([...allowedTenants]), is_active: true },
      select: { id: true, tenant_id: true, provider: true, auth_type: true, label: true },
    });
    if (config.providerIds.some((id) => !usable.some((p) => p.id === id)))
      throw new BadRequestException('A provider connection in this preset is no longer available');
    // Borrowed workspace providers are always available; own connections must
    // also be enabled by the snapshot being applied. Tenant-wide discovery alone
    // would otherwise accept a route whose account the preset disables.
    const enabled = usable.filter(
      (p) => p.tenant_id !== preset.tenant_id || config.providerIds.includes(p.id),
    );
    if (
      routes.some(
        (route) =>
          !enabled.some(
            (p) =>
              p.provider.toLowerCase() === route.provider.toLowerCase() &&
              p.auth_type === route.authType &&
              (!route.keyLabel || p.label === route.keyLabel),
          ),
      )
    ) {
      throw new BadRequestException(
        'Enable a matching provider connection for every model and pinned account in the preset',
      );
    }
    const headerIds = new Map(config.headers.map((header) => [header.sourceId, randomUUID()]));
    const now = toLocalSqlTimestamp();
    const base = (tier: PresetChain) => ({
      id: randomUUID(),
      agent_id: target.id,
      override_route: structuredClone(tier.route),
      fallback_routes: structuredClone(tier.fallbacks),
      output_modality: tier.outputModality,
      response_mode: tier.responseMode,
      updated_at: now,
    });
    await this.db.transaction(async (manager) => {
      await manager.findOneOrFail(Agent, {
        where: {
          id: target.id,
          tenant_id: preset.tenant_id,
          deleted_at: IsNull(),
          is_playground: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      for (const entity of [
        TierAssignment,
        SpecificityAssignment,
        HeaderTier,
        AgentModelParams,
        AgentEnabledProvider,
      ])
        await manager.delete(entity, { agent_id: target.id });
      if (config.tiers.length)
        await manager.insert(
          TierAssignment,
          config.tiers.map((tier) => ({
            ...base(tier),
            tier: tier.tier,
            auto_assigned_route: null,
          })),
        );
      if (config.specificity.length)
        await manager.insert(
          SpecificityAssignment,
          config.specificity.map((tier) => ({
            ...base(tier),
            category: tier.category,
            is_active: tier.active,
            auto_assigned_route: null,
          })),
        );
      if (config.headers.length)
        await manager.insert(
          HeaderTier,
          config.headers.map((tier) => ({
            ...base(tier),
            id: headerIds.get(tier.sourceId)!,
            tenant_id: preset.tenant_id,
            name: tier.name,
            header_key: tier.headerKey,
            header_value: tier.headerValue,
            badge_color: tier.badgeColor,
            sort_order: tier.sortOrder,
            enabled: tier.enabled,
            created_at: now,
          })),
        );
      if (config.modelParams.length)
        await manager.insert(
          AgentModelParams,
          config.modelParams.map((row) => ({
            id: randomUUID(),
            agent_id: target.id,
            scope_key: row.scope.startsWith('header:')
              ? `header:${headerIds.get(row.scope.slice(7))}`
              : row.scope,
            provider: row.provider,
            auth_type: row.authType,
            model_name: row.model,
            params: structuredClone(row.params) as never,
            created_at: now,
            updated_at: now,
          })),
        );
      if (config.providerIds.length)
        await manager.insert(
          AgentEnabledProvider,
          config.providerIds.map((id) => ({ agent_id: target.id, tenant_provider_id: id })),
        );
      await manager.update(
        Agent,
        { id: target.id },
        { complexity_routing_enabled: config.complexityRoutingEnabled, updated_at: now },
      );
    });
    this.routingCache.invalidateAgent(target.id);
    this.routingCache.invalidateTenant(preset.tenant_id);
    this.models.invalidate(target.id);
    return { ok: true, presetId: preset.id };
  }
}
