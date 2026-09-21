/**
 * Outcome of a live credential test against one provider connection.
 *
 * Deliberately distinct from `ProviderUsageStatus` (plan-usage): that probe
 * reads a *usage* endpoint and its own 401 message says "inference may still
 * work", so it cannot answer "does this account work". These statuses describe
 * a real inference round-trip.
 */
export type ConnectionTestStatus =
  /** A provider returned a usable completion. The account works. */
  | 'ok'
  /** The credential is gone or can no longer be refreshed — re-run the OAuth flow. */
  | 'needs_reconnect'
  /** A provider was contacted and rejected the call. `message` carries its error. */
  | 'failed'
  /** Nothing to test against (no discovered model, unroutable provider). */
  | 'untestable';

export interface ConnectionTestResult {
  connection_id: string;
  provider: string;
  label: string;
  status: ConnectionTestStatus;
  /** Model the ping was sent to, or null when the test never got that far. */
  model: string | null;
  /** Provider round-trip in ms, or null when no provider was contacted. */
  latency_ms: number | null;
  /** Upstream HTTP status, or null when no provider was contacted. */
  http_status: number | null;
  /** Human-readable outcome; carries the provider's own error text on failure. */
  message: string;
  tested_at: string;
}
