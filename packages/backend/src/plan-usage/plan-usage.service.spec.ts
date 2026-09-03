import { NotFoundException } from '@nestjs/common';
import type { TenantProvider } from '../entities/tenant-provider.entity';
import { PlanUsageService } from './plan-usage.service';

const provider = (over: Partial<TenantProvider>): TenantProvider =>
  ({
    id: 'tp-1',
    tenant_id: 'tenant-1',
    created_by_user_id: null,
    agent_id: null,
    provider: 'openai',
    api_key_encrypted: 'ciphertext',
    key_prefix: 'sk-abc',
    auth_type: 'subscription',
    label: 'Personal',
    priority: 0,
    region: null,
    is_active: true,
    connected_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    cached_models: null,
    models_fetched_at: null,
    ...over,
  }) as TenantProvider;

function harness(options?: {
  providers?: TenantProvider[];
  metrics?: unknown[];
  probe?: jest.Mock;
  credential?: jest.Mock;
}) {
  const providerRepo = {
    find: jest.fn().mockResolvedValue(options?.providers ?? [provider({})]),
  };
  const messageRepo = {
    query: jest.fn().mockResolvedValue(options?.metrics ?? []),
  };
  const probe =
    options?.probe ??
    jest.fn().mockResolvedValue({
      status: 'live',
      source: 'test_source',
      fetchedAt: '2026-09-02T00:00:00.000Z',
      planName: 'plus',
      windows: [],
    });
  const adapters = { probe };
  const credential = options?.credential ?? jest.fn().mockResolvedValue('decrypted-secret');
  const providerKeys = { getOwnedProviderCredentialById: credential };
  const service = new PlanUsageService(
    providerRepo as never,
    messageRepo as never,
    providerKeys as never,
    adapters as never,
  );
  return { service, providerRepo, messageRepo, probe, credential };
}

describe('PlanUsageService', () => {
  it('returns one row per owned non-local connection with exact-id 30-day metrics and zero fills', async () => {
    const ownedA = provider({ id: 'tp-a', label: 'A' });
    const ownedB = provider({ id: 'tp-b', provider: 'anthropic', label: 'B' });
    const local = provider({ id: 'tp-local', provider: 'ollama', auth_type: 'local' });
    const borrowed = provider({ id: 'tp-borrowed', tenant_id: 'tenant-2' });
    const { service, providerRepo, messageRepo } = harness({
      providers: [ownedA, ownedB, local, borrowed],
      metrics: [
        {
          tenant_provider_id: 'tp-a',
          requests: '3',
          tokens: '120',
          cost: '1.25',
          attempts: '4',
          succeeded: '3',
          last_used_at: new Date('2026-09-01T12:00:00.000Z'),
        },
      ],
    });

    const rows = await service.getPlanUsage('tenant-1');

    expect(providerRepo.find).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1' },
      order: { priority: 'ASC', id: 'ASC' },
    });
    expect(messageRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('at.tenant_provider_id = ANY($2::varchar[])'),
      ['tenant-1', ['tp-a', 'tp-b']],
    );
    expect(messageRepo.query.mock.calls[0][0]).toContain(
      "AND at.status NOT IN ('error', 'fallback_error', 'rate_limited', 'auto_fixed', 'failed')",
    );
    expect(messageRepo.query.mock.calls[0][0]).toContain('playag.is_playground = true');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tenant_provider_id: 'tp-a',
      provider: 'openai',
      label: 'A',
      observed_30d: {
        requests: 3,
        tokens: 120,
        estimated_cost_usd: 1.25,
        attempts: 4,
        succeeded: 3,
        success_rate: 75,
        last_used_at: '2026-09-01T12:00:00.000Z',
      },
    });
    expect(rows[1].observed_30d).toEqual({
      requests: 0,
      tokens: 0,
      estimated_cost_usd: 0,
      attempts: 0,
      succeeded: 0,
      success_rate: null,
      last_used_at: null,
    });
  });

  it('loads credentials only through the exact tenant-owned ID seam inside a supported probe', async () => {
    const { service, probe, credential } = harness();
    probe.mockImplementation(
      async (_connection: TenantProvider, load: () => Promise<string | null>) => ({
        status: 'live',
        source: 'test',
        fetchedAt: '2026-09-02T00:00:00.000Z',
        windows: [],
        proof: await load(),
      }),
    );

    const [row] = await service.getPlanUsage('tenant-1');

    expect(credential).toHaveBeenCalledWith('tenant-1', 'tp-1');
    expect(JSON.stringify(row)).not.toContain('decrypted-secret');
  });

  it('does not decrypt unsupported providers', async () => {
    const credential = jest.fn();
    const { service, probe } = harness({
      providers: [provider({ provider: 'mistral' })],
      credential,
    });
    probe.mockResolvedValue({
      status: 'unsupported',
      source: 'manifest_observed_only',
      fetchedAt: null,
      windows: [],
      message: 'Provider balance unavailable',
    });

    const [row] = await service.getPlanUsage('tenant-1');
    expect(row.quota.status).toBe('unsupported');
    expect(credential).not.toHaveBeenCalled();
  });

  it('uses a 15-minute successful cache and falls back to stale-good data after 429/unavailable', async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce({
        status: 'live',
        source: 'test',
        fetchedAt: '2026-09-02T00:00:00.000Z',
        windows: [{ name: '5-hour', usedPercent: 10 }],
      })
      .mockResolvedValueOnce({
        status: 'unavailable',
        source: 'test',
        fetchedAt: null,
        windows: [],
        message: 'Provider usage is rate limited',
      });
    const { service } = harness({ probe });

    const [first] = await service.getPlanUsage('tenant-1');
    const [cached] = await service.getPlanUsage('tenant-1');
    const [stale] = await service.getPlanUsage('tenant-1', 'tp-1');

    expect(first.quota.status).toBe('live');
    expect(cached.quota.status).toBe('cached');
    expect(stale.quota).toMatchObject({
      status: 'cached',
      stale: true,
      message: 'Provider usage is rate limited',
      windows: [{ name: '5-hour', usedPercent: 10 }],
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('validates a manual-refresh connection ID against the tenant', async () => {
    const { service, probe } = harness({ providers: [provider({ id: 'tp-owned' })] });

    await expect(service.getPlanUsage('tenant-1', 'tp-foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it('bounds concurrent provider probes to four', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const probe = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return { status: 'live', source: 'test', fetchedAt: new Date().toISOString(), windows: [] };
    });
    const providers = Array.from({ length: 9 }, (_, index) => provider({ id: `tp-${index}` }));
    const { service } = harness({ providers, probe });

    const pending = service.getPlanUsage('tenant-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(4);
    release.splice(0, 4).forEach((fn) => fn());
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(4);
    release.splice(0, 4).forEach((fn) => fn());
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(1);
    release.splice(0).forEach((fn) => fn());
    await pending;
    expect(maxActive).toBe(4);
  });

  it('returns no data and performs no reads without a tenant', async () => {
    const { service, providerRepo, messageRepo } = harness();
    await expect(service.getPlanUsage(null)).resolves.toEqual([]);
    expect(providerRepo.find).not.toHaveBeenCalled();
    expect(messageRepo.query).not.toHaveBeenCalled();
  });
});
