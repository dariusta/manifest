import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/api.js', () => ({
  testProviderConnection: vi.fn(),
}));

import {
  connectionTestResult,
  isConnectionTestRunning,
  runConnectionTest,
} from '../../src/services/connection-test-store';
import { testProviderConnection, type ConnectionTestResult } from '../../src/services/api.js';

const mockTest = testProviderConnection as unknown as ReturnType<typeof vi.fn>;

const result = (over: Partial<ConnectionTestResult> = {}): ConnectionTestResult => ({
  connection_id: 'tp-1',
  provider: 'gemini',
  label: 'vc pro',
  status: 'ok',
  model: 'gemini-flash',
  latency_ms: 412,
  http_status: 200,
  message: 'Replied in 412ms.',
  tested_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

// The store is a module-level singleton shared by every test in this file, so
// each case uses its own connection id rather than resetting state.
beforeEach(() => mockTest.mockClear());

describe('connection test store', () => {
  it('reports nothing and not-running for a connection that was never tested', () => {
    expect(connectionTestResult('tp-untouched')).toBeUndefined();
    expect(isConnectionTestRunning('tp-untouched')).toBe(false);
  });

  it('stores the result and clears the running flag on success', async () => {
    const ok = result({ connection_id: 'tp-ok' });
    mockTest.mockResolvedValueOnce(ok);

    await runConnectionTest('tp-ok');

    expect(mockTest).toHaveBeenCalledWith('tp-ok');
    expect(connectionTestResult('tp-ok')).toEqual(ok);
    expect(isConnectionTestRunning('tp-ok')).toBe(false);
  });

  it('marks the connection as running until the request settles', async () => {
    let release: (value: ConnectionTestResult) => void = () => {};
    mockTest.mockReturnValueOnce(
      new Promise<ConnectionTestResult>((resolve) => {
        release = resolve;
      }),
    );

    const pending = runConnectionTest('tp-pending');
    expect(isConnectionTestRunning('tp-pending')).toBe(true);

    release(result({ connection_id: 'tp-pending' }));
    await pending;
    expect(isConnectionTestRunning('tp-pending')).toBe(false);
  });

  it('ignores a second click while a test is already in flight', async () => {
    let release: (value: ConnectionTestResult) => void = () => {};
    mockTest.mockReturnValueOnce(
      new Promise<ConnectionTestResult>((resolve) => {
        release = resolve;
      }),
    );

    const pending = runConnectionTest('tp-double');
    await runConnectionTest('tp-double');
    expect(mockTest).toHaveBeenCalledTimes(1);

    release(result({ connection_id: 'tp-double' }));
    await pending;
  });

  it('records a thrown request failure in the same slot instead of a toast', async () => {
    mockTest.mockRejectedValueOnce(new Error('Connection not found'));

    await runConnectionTest('tp-thrown');

    expect(connectionTestResult('tp-thrown')).toMatchObject({
      connection_id: 'tp-thrown',
      status: 'failed',
      message: 'Connection not found',
      model: null,
      latency_ms: null,
      http_status: null,
    });
    expect(isConnectionTestRunning('tp-thrown')).toBe(false);
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    mockTest.mockRejectedValueOnce('nope');

    await runConnectionTest('tp-nonerror');

    expect(connectionTestResult('tp-nonerror')).toMatchObject({
      status: 'failed',
      message: 'Test failed',
    });
  });
});
