import { CACHE_MANAGER, CACHE_TTL_METADATA } from '@nestjs/cache-manager';
import { CallHandler, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import { firstValueFrom, of, type Observable } from 'rxjs';
import { UserCacheInterceptor } from './user-cache.interceptor';
import { DASHBOARD_CACHE_TTL_MS } from '../constants/cache.constants';

export const ANALYTICS_STALE_WINDOW_MS = 5 * 60_000;
interface Snapshot {
  kind: 'analytics-snapshot';
  value: unknown;
  freshUntil: number;
}

/** Retain tenant-scoped aggregates while one background refresh replaces them. */
@Injectable()
export class StaleAnalyticsCacheInterceptor extends UserCacheInterceptor {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly log = new Logger(StaleAnalyticsCacheInterceptor.name);
  constructor(
    @Inject(CACHE_MANAGER) private readonly responses: Cache,
    private readonly metadata: Reflector,
  ) {
    super(responses, metadata);
  }
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const key = this.trackBy(context);
    if (!key) return super.intercept(context, next);
    let cached: Snapshot | undefined;
    try {
      cached = await this.responses.get<Snapshot>(key);
    } catch {
      /* Serve the query if the cache is unavailable. */
    }
    const snapshot = cached?.kind === 'analytics-snapshot' ? cached : undefined;
    if (snapshot && snapshot.freshUntil > Date.now()) return of(snapshot.value);
    let refresh = this.pending.get(key);
    if (!refresh) {
      const ttl =
        this.metadata.getAllAndOverride<number>(CACHE_TTL_METADATA, [
          context.getHandler(),
          context.getClass(),
        ]) ?? DASHBOARD_CACHE_TTL_MS;
      refresh = Promise.resolve()
        .then(() => firstValueFrom(next.handle()))
        .then(async (value) => {
          try {
            await this.responses.set(
              key,
              { kind: 'analytics-snapshot', value, freshUntil: Date.now() + ttl },
              ttl + ANALYTICS_STALE_WINDOW_MS,
            );
          } catch (error) {
            this.log.warn(
              `Could not cache analytics response: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    if (snapshot && snapshot.freshUntil + ANALYTICS_STALE_WINDOW_MS > Date.now()) {
      void refresh.catch(() => undefined);
      return of(snapshot.value);
    }
    return of(await refresh);
  }
}
