import { createSignal } from 'solid-js';
import { testProviderConnection, type ConnectionTestResult } from './api.js';

/**
 * Per-connection test state, keyed by `tenant_providers.id`.
 *
 * A module-level store rather than component state because the button and the
 * result line live in different parts of the account-card markup — and that
 * markup differs across the three detail views (OAuth, device-code, Anthropic).
 * Keying by connection id lets each view drop in the two pieces wherever they
 * fit without threading state between them.
 */
const [results, setResults] = createSignal<Record<string, ConnectionTestResult>>({});
const [running, setRunning] = createSignal<Record<string, boolean>>({});

export function connectionTestResult(connectionId: string): ConnectionTestResult | undefined {
  return results()[connectionId];
}

export function isConnectionTestRunning(connectionId: string): boolean {
  return running()[connectionId] === true;
}

export async function runConnectionTest(connectionId: string): Promise<void> {
  if (isConnectionTestRunning(connectionId)) return;
  setRunning((prev) => ({ ...prev, [connectionId]: true }));
  try {
    const result = await testProviderConnection(connectionId);
    setResults((prev) => ({ ...prev, [connectionId]: result }));
  } catch (err) {
    // The endpoint returns 200 for a failed *test*, so reaching here means the
    // call itself failed (offline, connection deleted in another tab). Report it
    // in the same slot rather than a toast, so it sits with the account it's about.
    setResults((prev) => ({
      ...prev,
      [connectionId]: {
        connection_id: connectionId,
        provider: '',
        label: '',
        status: 'failed',
        model: null,
        latency_ms: null,
        http_status: null,
        message: err instanceof Error ? err.message : 'Test failed',
        tested_at: new Date().toISOString(),
      },
    }));
  } finally {
    setRunning((prev) => ({ ...prev, [connectionId]: false }));
  }
}
