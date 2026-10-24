import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createCachedResource } from '../../src/services/cached-resource';
import { createSignal } from 'solid-js';
import { cachedFetch, DEFAULT_TTL_MS, invalidateAll } from '../../src/services/api/cache';

afterEach(() => {
  invalidateAll();
  vi.useRealTimers();
});
it('switches cache keys and adopts the new resource when a harness changes', async () => {
  const [name, setName] = createSignal('source');
  render(() => {
    const [value] = createCachedResource(name, (agent) =>
      cachedFetch(`/tiers/${agent}`, async () => agent),
    );
    return <span>{value()}</span>;
  });
  await waitFor(() => expect(screen.getByText('source')).toBeTruthy());
  setName('copy');
  await waitFor(() => expect(screen.getByText('copy')).toBeTruthy());
});
it('renders cached data immediately and adopts a completed background refresh', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await cachedFetch('/swr-render', async () => ({ count: 10 }));
  vi.mocked(Date.now).mockReturnValue(now + DEFAULT_TTL_MS + 1);
  let complete!: (value: { count: number }) => void;
  const network = vi.fn(
    () =>
      new Promise<{ count: number }>((resolve) => {
        complete = resolve;
      }),
  );
  render(() => {
    const [value] = createCachedResource(() => cachedFetch('/swr-render', network));
    return <span>{value()?.count}</span>;
  });
  await waitFor(() => expect(screen.getByText('10')).toBeTruthy());
  expect(network).toHaveBeenCalledTimes(1);
  complete({ count: 25 });
  await waitFor(() => expect(screen.getByText('25')).toBeTruthy());
  expect(network).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});
