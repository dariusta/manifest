import { createResource, onCleanup } from 'solid-js';
import { observeCacheUpdates, trackCacheReads } from './api/cache.js';

/** A resource that also adopts completed SWR refreshes while it remains mounted. */
export const createCachedResource: typeof createResource = ((...args: unknown[]) => {
  const keys = new Set<string>();
  const fetcherIndex = typeof args[1] === 'function' ? 1 : 0;
  const fetcher = args[fetcherIndex] as (...values: unknown[]) => unknown;
  args[fetcherIndex] = (...values: unknown[]) => {
    keys.clear();
    return trackCacheReads(
      (key) => keys.add(key),
      () => fetcher(...values),
    );
  };
  const resource = (createResource as (...values: unknown[]) => ReturnType<typeof createResource>)(
    ...args,
  );
  let disposed = false;
  const unsubscribe = observeCacheUpdates((key) => {
    if (!keys.has(key) || resource[0].state !== 'ready') return;
    queueMicrotask(() => {
      if (!disposed) void resource[1].refetch();
    });
  });
  onCleanup(() => {
    disposed = true;
    unsubscribe();
  });
  return resource;
}) as typeof createResource;
