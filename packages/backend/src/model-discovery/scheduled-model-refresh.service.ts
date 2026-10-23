import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Repository } from 'typeorm';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { LIVE_CATALOG_PROVIDERS, ModelDiscoveryService } from './model-discovery.service';

/** A catalog older than this is re-discovered on the next hourly run. */
export const SCHEDULED_REFRESH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const REFRESH_CONCURRENCY = 4;
const REFRESH_LOCK_KEY = 4011987;
const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock($1::bigint) AS acquired';
const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1::bigint)';

/**
 * Re-discovers the cached model catalogs of LIVE_CATALOG_PROVIDERS on a
 * schedule, so newly released models appear (and retired ones disappear)
 * without anyone pressing "Refresh models".
 */
@Injectable()
export class ScheduledModelRefreshService {
  private readonly logger = new Logger(ScheduledModelRefreshService.name);
  private readonly dbPoolMax: number;
  // A refresh that keeps failing (expired OAuth token, revoked key) leaves
  // models_fetched_at untouched; remembering the attempt stops this process
  // from retrying that row every hour.
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly discovery: ModelDiscoveryService,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.dbPoolMax = config.get<number>('app.dbPoolMax') ?? 10;
  }

  /**
   * Re-discover stale catalogs. The advisory lock keeps replicas from
   * refreshing the same rows at once; returns how many rows were attempted.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'scheduled-model-refresh', waitForCompletion: true })
  async refreshStaleCatalogs(now = Date.now()): Promise<number> {
    // The lock pins one pooled connection for the whole run while discovery
    // writes need another; with a single-connection pool that would deadlock.
    if (this.dbPoolMax < 2) {
      this.logger.warn('Scheduled model refresh skipped: DB_POOL_MAX must be at least 2');
      return 0;
    }
    const queryRunner = this.dataSource.createQueryRunner();
    let acquired = false;
    try {
      await queryRunner.connect();
      const lockRows = (await queryRunner.query(TRY_LOCK_SQL, [REFRESH_LOCK_KEY])) as Array<{
        acquired?: boolean;
      }>;
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) return 0;

      const due = await this.findDue(now);
      for (let i = 0; i < due.length; i += REFRESH_CONCURRENCY) {
        await Promise.all(due.slice(i, i + REFRESH_CONCURRENCY).map((p) => this.refresh(p)));
      }
      if (due.length > 0) {
        this.logger.log(`Scheduled model refresh attempted ${due.length} provider catalog(s)`);
      }
      return due.length;
    } catch (error) {
      this.logger.error(
        `Scheduled model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      if (acquired) {
        await queryRunner.query(UNLOCK_SQL, [REFRESH_LOCK_KEY]).catch(() => undefined);
      }
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async findDue(now: number): Promise<TenantProvider[]> {
    const cutoff = now - SCHEDULED_REFRESH_MAX_AGE_MS;
    for (const [id, attemptedAt] of this.lastAttemptAt) {
      if (attemptedAt <= cutoff) this.lastAttemptAt.delete(id);
    }
    const provider = In([...LIVE_CATALOG_PROVIDERS]);
    const stale = await this.providerRepo.find({
      where: [
        { provider, is_active: true, models_fetched_at: LessThan(new Date(cutoff).toISOString()) },
        { provider, is_active: true, models_fetched_at: IsNull() },
      ],
    });
    const due = stale.filter((p) => !this.lastAttemptAt.has(p.id));
    for (const p of due) this.lastAttemptAt.set(p.id, now);
    return due;
  }

  private async refresh(provider: TenantProvider): Promise<void> {
    try {
      await this.discovery.discoverModels(provider);
    } catch (error) {
      this.logger.warn(
        `Scheduled model refresh failed for ${provider.provider} (tenant ${provider.tenant_id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
