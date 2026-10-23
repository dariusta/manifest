import { Logger } from '@nestjs/common';
import { In, IsNull, LessThan } from 'typeorm';
import {
  SCHEDULED_REFRESH_MAX_AGE_MS,
  ScheduledModelRefreshService,
} from './scheduled-model-refresh.service';
import { TenantProvider } from '../entities/tenant-provider.entity';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function makeProvider(id: string, overrides: Partial<TenantProvider> = {}): TenantProvider {
  return {
    id,
    tenant_id: `tenant-${id}`,
    provider: 'openai',
    auth_type: 'subscription',
    is_active: true,
    models_fetched_at: null,
    ...overrides,
  } as TenantProvider;
}

describe('ScheduledModelRefreshService', () => {
  const query = jest.fn();
  const connect = jest.fn();
  const release = jest.fn();
  const createQueryRunner = jest.fn(() => ({ query, connect, release }));
  const providerRepo = { find: jest.fn() };
  const discovery = { discoverModels: jest.fn() };
  const config = { get: jest.fn() };
  let service: ScheduledModelRefreshService;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    connect.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [],
    );
    providerRepo.find.mockResolvedValue([]);
    discovery.discoverModels.mockResolvedValue([]);
    config.get.mockReturnValue(10);
    service = new ScheduledModelRefreshService(
      providerRepo as never,
      discovery as never,
      { createQueryRunner } as never,
      config as never,
    );
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('re-discovers active OpenAI catalogs that are stale or were never fetched', async () => {
    const stale = makeProvider('stale', { models_fetched_at: '2026-10-22T00:00:00.000Z' });
    const never = makeProvider('never', { auth_type: 'api_key' });
    providerRepo.find.mockResolvedValue([stale, never]);

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(2);

    const cutoff = new Date(NOW - SCHEDULED_REFRESH_MAX_AGE_MS).toISOString();
    expect(providerRepo.find).toHaveBeenCalledWith({
      where: [
        { provider: In(['openai']), is_active: true, models_fetched_at: LessThan(cutoff) },
        { provider: In(['openai']), is_active: true, models_fetched_at: IsNull() },
      ],
    });
    expect(discovery.discoverModels).toHaveBeenCalledWith(stale);
    expect(discovery.discoverModels).toHaveBeenCalledWith(never);
    expect(log).toHaveBeenCalledWith('Scheduled model refresh attempted 2 provider catalog(s)');
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1::bigint)', [4011987]);
    expect(release).toHaveBeenCalled();
  });

  it('runs on the default clock when invoked by the scheduler', async () => {
    await expect(service.refreshStaleCatalogs()).resolves.toBe(0);

    expect(providerRepo.find).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('bounds how many catalogs refresh at once', async () => {
    const providers = Array.from({ length: 6 }, (_, i) => makeProvider(`p${i}`));
    providerRepo.find.mockResolvedValue(providers);
    let inFlight = 0;
    let peak = 0;
    discovery.discoverModels.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return [];
    });

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(6);

    expect(discovery.discoverModels).toHaveBeenCalledTimes(6);
    expect(peak).toBe(4);
  });

  it('does not retry a failing catalog on every run, but does once the window passes', async () => {
    const broken = makeProvider('broken');
    providerRepo.find.mockResolvedValue([broken]);
    discovery.discoverModels.mockRejectedValue(new Error('401 token expired'));

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'Scheduled model refresh failed for openai (tenant tenant-broken): 401 token expired',
    );

    await expect(service.refreshStaleCatalogs(NOW + 60 * 60 * 1000)).resolves.toBe(0);
    await expect(service.refreshStaleCatalogs(NOW + SCHEDULED_REFRESH_MAX_AGE_MS)).resolves.toBe(1);
    expect(discovery.discoverModels).toHaveBeenCalledTimes(2);
  });

  it('logs non-Error discovery failures', async () => {
    providerRepo.find.mockResolvedValue([makeProvider('odd')]);
    discovery.discoverModels.mockRejectedValue('boom');

    await service.refreshStaleCatalogs(NOW);

    expect(warn).toHaveBeenCalledWith(
      'Scheduled model refresh failed for openai (tenant tenant-odd): boom',
    );
  });

  it('skips the run when the DB pool cannot hold the lock plus a discovery write', async () => {
    config.get.mockReturnValue(1);
    const singleConnection = new ScheduledModelRefreshService(
      providerRepo as never,
      discovery as never,
      { createQueryRunner } as never,
      config as never,
    );

    await expect(singleConnection.refreshStaleCatalogs(NOW)).resolves.toBe(0);

    expect(config.get).toHaveBeenCalledWith('app.dbPoolMax');
    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Scheduled model refresh skipped: DB_POOL_MAX must be at least 2',
    );
  });

  it('assumes the default pool size when none is configured', async () => {
    config.get.mockReturnValue(undefined);
    const defaults = new ScheduledModelRefreshService(
      providerRepo as never,
      discovery as never,
      { createQueryRunner } as never,
      config as never,
    );

    await expect(defaults.refreshStaleCatalogs(NOW)).resolves.toBe(0);

    expect(createQueryRunner).toHaveBeenCalled();
  });

  it('skips the run when another replica holds the lock', async () => {
    query.mockResolvedValue([{ acquired: false }]);

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(0);

    expect(providerRepo.find).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      [4011987],
    );
    expect(release).toHaveBeenCalled();
  });

  it('reports a failed run and still releases the lock', async () => {
    providerRepo.find.mockRejectedValue(new Error('connection reset'));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      throw new Error('unlock failed');
    });
    release.mockRejectedValue(new Error('release failed'));

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Scheduled model refresh failed: connection reset');
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1::bigint)', [4011987]);
  });

  it('reports non-Error run failures', async () => {
    connect.mockRejectedValue('pool exhausted');

    await expect(service.refreshStaleCatalogs(NOW)).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Scheduled model refresh failed: pool exhausted');
  });
});
