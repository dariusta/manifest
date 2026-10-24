import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, ReplaySubject, throwError } from 'rxjs';
import {
  StaleAnalyticsCacheInterceptor,
  ANALYTICS_STALE_WINDOW_MS,
} from './stale-analytics-cache.interceptor';

const context = (tenantId = 'tenant-a', url = '/api/v1/overview', method = 'GET') =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, originalUrl: url, tenantContext: { tenantId } }),
    }),
    getHandler: () => context,
    getClass: () => StaleAnalyticsCacheInterceptor,
  }) as unknown as ExecutionContext;

describe('StaleAnalyticsCacheInterceptor', () => {
  let interceptor: StaleAnalyticsCacheInterceptor;
  let values: Map<string, unknown>;
  let cache: { get: jest.Mock; set: jest.Mock };
  let now: number;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const read = async (next: CallHandler, ctx = context()) =>
    firstValueFrom(await interceptor.intercept(ctx, next));

  beforeEach(() => {
    now = 100_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    values = new Map();
    cache = {
      get: jest.fn(async (key: string) => values.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
    };
    interceptor = new StaleAnalyticsCacheInterceptor(cache as never, new Reflector());
  });
  afterEach(() => jest.restoreAllMocks());

  it('serves a fresh aggregate without querying its handler', async () => {
    values.set('tenant-a:/api/v1/overview', {
      kind: 'analytics-snapshot',
      value: { count: 12 },
      freshUntil: now + 1,
    });
    const next = { handle: jest.fn(() => of({ count: 99 })) };
    expect(await read(next)).toEqual({ count: 12 });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('serves stale data immediately and shares one background refresh', async () => {
    values.set('tenant-a:/api/v1/overview', {
      kind: 'analytics-snapshot',
      value: { count: 12 },
      freshUntil: now - 1,
    });
    const source = new ReplaySubject<unknown>(1);
    const next = { handle: jest.fn(() => source) };
    expect(await read(next)).toEqual({ count: 12 });
    expect(await read(next)).toEqual({ count: 12 });
    expect(next.handle).toHaveBeenCalledTimes(1);
    source.next({ count: 25 });
    source.complete();
    await settle();
    expect(await read(next)).toEqual({ count: 25 });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      'tenant-a:/api/v1/overview',
      expect.objectContaining({ value: { count: 25 } }),
      30_000 + ANALYTICS_STALE_WINDOW_MS,
    );
  });

  it('coalesces concurrent cold loads and keeps tenant and range keys separate', async () => {
    const source = new ReplaySubject<unknown>(1);
    const next = { handle: jest.fn(() => source) };
    const first = read(next);
    const second = read(next);
    source.next({ count: 1 });
    source.complete();
    await expect(Promise.all([first, second])).resolves.toEqual([{ count: 1 }, { count: 1 }]);
    expect(next.handle).toHaveBeenCalledTimes(1);
    await read(next, context('tenant-b'));
    await read(next, context('tenant-a', '/api/v1/overview?range=7d'));
    expect(next.handle).toHaveBeenCalledTimes(3);
  });

  it('retains the last snapshot on a background failure and retries later', async () => {
    values.set('tenant-a:/api/v1/overview', {
      kind: 'analytics-snapshot',
      value: { count: 12 },
      freshUntil: now - 1,
    });
    const next = {
      handle: jest
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('query unavailable')))
        .mockReturnValueOnce(of({ count: 25 })),
    };
    expect(await read(next)).toEqual({ count: 12 });
    await settle();
    expect(await read(next)).toEqual({ count: 12 });
    await settle();
    expect(await read(next)).toEqual({ count: 25 });
  });

  it('does not serve data beyond the retention window or cache failures', async () => {
    values.set('tenant-a:/api/v1/overview', {
      kind: 'analytics-snapshot',
      value: { count: 12 },
      freshUntil: now - ANALYTICS_STALE_WINDOW_MS - 1,
    });
    const next = {
      handle: jest
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('query failed')))
        .mockReturnValueOnce(of({ count: 25 })),
    };
    await expect(read(next)).rejects.toThrow('query failed');
    expect(await read(next)).toEqual({ count: 25 });
    expect(next.handle).toHaveBeenCalledTimes(2);
  });

  it('bypasses caching for mutations', async () => {
    const next = { handle: jest.fn(() => of({ ok: true })) };
    expect(await read(next, context('tenant-a', '/api/v1/overview', 'POST'))).toEqual({ ok: true });
    expect(cache.get).not.toHaveBeenCalled();
  });
});
