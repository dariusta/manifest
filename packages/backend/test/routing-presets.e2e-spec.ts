import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { entities, migrations } from '../src/database/data-source-definitions';
import { RoutingPresetService } from '../src/routing/presets/routing-preset.service';
import { RoutingPresetEntity } from '../src/entities/routing-preset.entity';
import { Tenant } from '../src/entities/tenant.entity';
import { Agent } from '../src/entities/agent.entity';
import { TenantProvider } from '../src/entities/tenant-provider.entity';
import { TierAssignment } from '../src/entities/tier-assignment.entity';
import { HeaderTier } from '../src/entities/header-tier.entity';
import { AgentModelParams } from '../src/entities/agent-model-params.entity';
import { AgentEnabledProvider } from '../src/entities/agent-enabled-provider.entity';

describe('routing presets with PostgreSQL', () => {
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const source = randomUUID();
  const target = randomUUID();
  const connection = randomUUID();
  const header = randomUUID();
  const first = { provider: 'openai', authType: 'api_key' as const, model: 'model-a' };
  const second = { ...first, model: 'model-b' };
  const discovery = {
    getModelsForAgent: jest.fn(async () =>
      [first, second].map((r) => ({ id: r.model, provider: r.provider, authType: r.authType })),
    ),
    invalidate: jest.fn(),
  };
  const cache = { invalidateAgent: jest.fn(), invalidateTenant: jest.fn() };
  let db: DataSource;
  let service: RoutingPresetService;
  let id: string;

  beforeAll(async () => {
    db = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities,
      migrations,
      migrationsTransactionMode: 'each',
      // Other E2E suites use synchronize:true and leave a partial schema.
      // Rebuild from migrations so this suite is independent of run order.
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'each' });
    await db.getRepository(Tenant).insert([
      { id: tenant, name: tenant },
      { id: otherTenant, name: otherTenant },
    ]);
    await db.getRepository(Agent).insert([
      { id: source, name: 'preset-source', tenant_id: tenant },
      { id: target, name: 'preset-target', tenant_id: tenant },
    ]);
    await db.getRepository(TenantProvider).insert({
      id: connection,
      tenant_id: tenant,
      provider: 'openai',
      auth_type: 'api_key',
      label: 'Default',
      api_key_encrypted: 'test-only-ciphertext',
    });
    await db
      .getRepository(AgentEnabledProvider)
      .insert({ agent_id: source, tenant_provider_id: connection });
    await db.getRepository(TierAssignment).insert({
      id: randomUUID(),
      agent_id: source,
      tier: 'default',
      override_route: first,
      fallback_routes: [second],
      output_modality: 'text',
      response_mode: 'buffered',
    });
    await db.getRepository(HeaderTier).insert({
      id: header,
      agent_id: source,
      tenant_id: tenant,
      name: 'Coding',
      header_key: 'x-task',
      header_value: 'code',
      badge_color: 'blue',
      override_route: second,
      fallback_routes: [first],
      output_modality: 'text',
      response_mode: 'buffered',
    });
    await db.getRepository(AgentModelParams).insert({
      id: randomUUID(),
      agent_id: source,
      scope_key: `header:${header}`,
      provider: 'openai',
      model_name: 'model-b',
      auth_type: 'api_key',
      params: { temperature: 0.2 } as never,
    });
    service = new RoutingPresetService(
      db,
      discovery as never,
      cache as never,
      { sharedProviderTenantIds: async () => [] } as never,
    );
  }, 30_000);
  afterAll(async () => {
    if (!db?.isInitialized) return;
    for (const entity of [AgentModelParams, AgentEnabledProvider, HeaderTier, TierAssignment]) {
      await db.getRepository(entity).delete({ agent_id: source });
      await db.getRepository(entity).delete({ agent_id: target });
    }
    await db.getRepository(Agent).delete({ tenant_id: tenant });
    await db.getRepository(TenantProvider).delete({ tenant_id: tenant });
    await db.getRepository(Tenant).delete([{ id: tenant }, { id: otherTenant }]);
    await db.destroy();
  });

  it('saves primary models, ordered fallbacks, accounts, custom tiers and parameters', async () => {
    const preset = await service.create(tenant, 'Coding preset', 'preset-source');
    id = preset.id;
    expect(preset.config.tiers[0]).toMatchObject({ route: first, fallbacks: [second] });
    expect(preset.config.providerIds).toEqual([connection]);
    expect(preset.config.modelParams[0]).toMatchObject({
      scope: `header:${header}`,
      params: { temperature: 0.2 } as never,
    });
    expect(await service.list(otherTenant)).toEqual([]);
  });
  it('copies the preset and remaps custom-tier parameter scopes to new IDs', async () => {
    await service.apply(tenant, id, 'preset-target');
    const tier = await db
      .getRepository(TierAssignment)
      .findOneByOrFail({ agent_id: target, tier: 'default' });
    expect(tier.override_route).toEqual(first);
    expect(tier.fallback_routes).toEqual([second]);
    const copy = await db.getRepository(HeaderTier).findOneByOrFail({ agent_id: target });
    expect(copy.id).not.toBe(header);
    const params = await db.getRepository(AgentModelParams).findOneByOrFail({ agent_id: target });
    expect(params.scope_key).toBe(`header:${copy.id}`);
    expect(params.params).toEqual({ temperature: 0.2 });
    expect(cache.invalidateAgent).toHaveBeenCalledWith(target);
  });
  it('leaves applied harnesses unchanged when a preset is edited', async () => {
    const preset = await db.getRepository(RoutingPresetEntity).findOneByOrFail({ id });
    const config = structuredClone(preset.config);
    config.tiers[0].route = second;
    config.tiers[0].fallbacks = [first];
    await service.update(tenant, id, { name: 'Updated preset', config });
    expect(
      (await db.getRepository(TierAssignment).findOneByOrFail({ agent_id: target })).override_route,
    ).toEqual(first);
    expect(
      (await db.getRepository(RoutingPresetEntity).findOneByOrFail({ id })).config.tiers[0].route,
    ).toEqual(second);
  });
  it('rejects cross-tenant reads, edits, applies and deletes', async () => {
    await expect(service.update(otherTenant, id, { name: 'stolen' })).rejects.toThrow('not found');
    await expect(service.apply(otherTenant, id, 'preset-target')).rejects.toThrow('not found');
    await expect(service.delete(otherTenant, id)).rejects.toThrow('not found');
    await expect(service.apply(tenant, id, 'missing-harness')).rejects.toThrow('not found');
  });
  it('does not change routing when a selected model is unavailable', async () => {
    discovery.getModelsForAgent.mockResolvedValueOnce([]);
    await expect(service.apply(tenant, id, 'preset-target')).rejects.toThrow('Connect or refresh');
    expect(
      (await db.getRepository(TierAssignment).findOneByOrFail({ agent_id: target })).override_route,
    ).toEqual(first);
  });
  it('rejects disabled provider routes without changing the harness', async () => {
    const preset = await db.getRepository(RoutingPresetEntity).findOneByOrFail({ id });
    await service.update(tenant, id, { config: { ...preset.config, providerIds: [] } });
    try {
      await expect(service.apply(tenant, id, 'preset-target')).rejects.toThrow(
        'Enable a matching provider',
      );
      expect(
        (await db.getRepository(TierAssignment).findOneByOrFail({ agent_id: target }))
          .override_route,
      ).toEqual(first);
    } finally {
      await service.update(tenant, id, { config: preset.config });
    }
  });
  it('cannot apply a preset to a deleted or internal playground harness', async () => {
    await db.getRepository(Agent).update(target, { is_playground: true });
    try {
      await expect(service.apply(tenant, id, 'preset-target')).rejects.toThrow('Harness not found');
    } finally {
      await db.getRepository(Agent).update(target, { is_playground: false });
    }
    await db.getRepository(Agent).update(target, { deleted_at: '2026-10-23 00:00:00' });
    try {
      await expect(service.apply(tenant, id, 'preset-target')).rejects.toThrow('Harness not found');
    } finally {
      await db.getRepository(Agent).update(target, { deleted_at: null });
    }
  });
  it('rolls back the complete apply when a database write fails', async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION reject_test_preset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_id = '${target}' THEN RAISE EXCEPTION 'test preset write failure'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      'CREATE TRIGGER reject_test_preset BEFORE INSERT ON tier_assignments FOR EACH ROW EXECUTE FUNCTION reject_test_preset()',
    );
    try {
      await expect(service.apply(tenant, id, 'preset-target')).rejects.toThrow(
        'test preset write failure',
      );
      expect(
        (await db.getRepository(TierAssignment).findOneByOrFail({ agent_id: target }))
          .override_route,
      ).toEqual(first);
      expect(await db.getRepository(HeaderTier).countBy({ agent_id: target })).toBe(1);
      expect(await db.getRepository(AgentEnabledProvider).countBy({ agent_id: target })).toBe(1);
    } finally {
      await db.query('DROP TRIGGER reject_test_preset ON tier_assignments');
      await db.query('DROP FUNCTION reject_test_preset()');
    }
  });
  it('deletes a preset without changing the harnesses that used it', async () => {
    await service.delete(tenant, id);
    expect(await service.list(tenant)).toEqual([]);
    expect(
      (await db.getRepository(TierAssignment).findOneByOrFail({ agent_id: target })).override_route,
    ).toEqual(first);
  });
});
