import { Injectable, OnModuleDestroy, HttpStatus } from '@nestjs/common';
import { ManifestError } from '../../common/errors/manifest-error';
import { optionalPositiveInteger } from '../../config/env.util';

const RATE_WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 50_000;
const CLEANUP_INTERVAL_MS = 60_000;

export const DEFAULT_RATE_MAX_REQUESTS = 200;
export const DEFAULT_IP_RATE_MAX_REQUESTS = 500;
export const DEFAULT_CONCURRENCY_MAX = 10;

/**
 * Resolve one proxy limit from the environment.
 *
 * `0` (or any value ≤ 0) means **unlimited**: the corresponding check is
 * skipped outright, bookkeeping included, so an uncapped deployment never
 * grows a map it will never read. Unset, blank, or unparseable falls back to
 * the shipped default — a typo must not silently uncap a public gateway.
 */
export function parseProxyLimit(rawValue: string | undefined, fallback: number): number {
  if (!rawValue || rawValue.trim() === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed <= 0 ? Infinity : parsed;
}

interface RateEntry {
  count: number;
  windowStart: number;
}

@Injectable()
export class ProxyRateLimiter implements OnModuleDestroy {
  private readonly rates = new Map<string, RateEntry>();
  private readonly ipRates = new Map<string, RateEntry>();
  private readonly concurrency = new Map<string, number>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  /** Requests per tenant per minute. `Infinity` = uncapped. */
  private readonly rateMaxRequests: number;
  /** Requests per source IP per minute. `Infinity` = uncapped. */
  private readonly ipRateMaxRequests: number;
  /** Simultaneous in-flight proxy requests per tenant. `Infinity` = uncapped. */
  private readonly concurrencyMax: number;

  constructor() {
    // Read once at construction — these are deployment-level knobs, so a
    // change means a restart, and per-request env reads would show up on the
    // hot path of every proxied call.
    this.rateMaxRequests = parseProxyLimit(
      process.env['PROXY_RATE_MAX_REQUESTS'],
      DEFAULT_RATE_MAX_REQUESTS,
    );
    this.ipRateMaxRequests = parseProxyLimit(
      process.env['PROXY_IP_RATE_MAX_REQUESTS'],
      DEFAULT_IP_RATE_MAX_REQUESTS,
    );
    const proxyConcurrencyMax = process.env['PROXY_CONCURRENCY_MAX'];
    this.concurrencyMax =
      proxyConcurrencyMax !== undefined
        ? parseProxyLimit(proxyConcurrencyMax, DEFAULT_CONCURRENCY_MAX)
        : (optionalPositiveInteger(process.env['MANIFEST_CONCURRENCY_MAX']) ??
          DEFAULT_CONCURRENCY_MAX);
    this.cleanupTimer = setInterval(() => this.evictExpired(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Check if the tenant is over the rate limit and increment the counter.
   * All requests count toward the limit (both successful and failed).
   */
  checkLimit(tenantId: string): void {
    if (this.rateMaxRequests === Infinity) return;

    const now = Date.now();
    let entry = this.rates.get(tenantId);

    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    if (entry.count >= this.rateMaxRequests) {
      throw new ManifestError('M201', HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    // LRU touch: delete-then-set re-inserts at tail of insertion order so
    // evictLruIfNeeded() drops genuinely-stale entries instead of arbitrary
    // long-lived ones during overflow.
    this.rates.delete(tenantId);
    this.rates.set(tenantId, entry);
    this.evictLruIfNeeded();
  }

  /**
   * Check if the IP is over the per-IP rate limit and increment the counter.
   * This catches abuse even when many requests share a single tenantId (e.g. dev).
   */
  checkIpLimit(ip: string): void {
    if (this.ipRateMaxRequests === Infinity) return;

    const now = Date.now();
    let entry = this.ipRates.get(ip);

    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    if (entry.count >= this.ipRateMaxRequests) {
      throw new ManifestError('M202', HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    // LRU touch — see checkLimit().
    this.ipRates.delete(ip);
    this.ipRates.set(ip, entry);
    this.evictIpLruIfNeeded();
  }

  acquireSlot(tenantId: string): void {
    if (this.concurrencyMax === Infinity) return;

    const current = this.concurrency.get(tenantId) ?? 0;
    if (current >= this.concurrencyMax) {
      throw new ManifestError('M203', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.concurrency.set(tenantId, current + 1);
  }

  releaseSlot(tenantId: string): void {
    // Mirrors acquireSlot: uncapped means nothing was ever counted. The
    // controller still calls this in its finally block.
    if (this.concurrencyMax === Infinity) return;

    const current = this.concurrency.get(tenantId) ?? 0;
    if (current <= 1) {
      this.concurrency.delete(tenantId);
    } else {
      this.concurrency.set(tenantId, current - 1);
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.rates) {
      if (now - entry.windowStart >= RATE_WINDOW_MS) {
        this.rates.delete(key);
      }
    }
    for (const [key, entry] of this.ipRates) {
      if (now - entry.windowStart >= RATE_WINDOW_MS) {
        this.ipRates.delete(key);
      }
    }
  }

  private evictLruIfNeeded(): void {
    while (this.rates.size > MAX_RATE_ENTRIES) {
      const oldest = this.rates.keys().next().value as string;
      this.rates.delete(oldest);
    }
  }

  private evictIpLruIfNeeded(): void {
    while (this.ipRates.size > MAX_RATE_ENTRIES) {
      const oldest = this.ipRates.keys().next().value as string;
      this.ipRates.delete(oldest);
    }
  }
}
