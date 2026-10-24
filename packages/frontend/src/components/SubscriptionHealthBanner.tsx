import { For, Show, type Component } from 'solid-js';
import type { ConnectionTestResult, TenantProviderConnection } from '../services/api/providers.js';
import {
  connectionTestResult,
  isConnectionTestRunning,
  runConnectionTest,
} from '../services/connection-test-store.js';
import '../styles/subscription-health.css';

export interface SubscriptionIssue {
  status: 'needs_reconnect' | 'refresh' | 'failed';
  message: string;
}

export function subscriptionIssue(
  connection: TenantProviderConnection,
  result?: ConnectionTestResult,
): SubscriptionIssue | undefined {
  if (!connection.is_active || connection.shared) return;
  if (result?.status === 'needs_reconnect') {
    return { status: 'needs_reconnect', message: 'Sign in again to relink this subscription.' };
  }
  if (connection.cached_model_count === 0 || result?.status === 'untestable') {
    return { status: 'refresh', message: 'Refresh models so this subscription can be used.' };
  }
  if (result?.status === 'failed') return { status: 'failed', message: result.message };
}

interface ConnectionRow {
  connection: TenantProviderConnection;
  provider: string;
  name: string;
}

interface Props {
  rows: ConnectionRow[];
  health: Map<string, ConnectionTestResult>;
  canManage: boolean;
  refreshingProvider: string | null;
  onManage: (provider: string, result?: ConnectionTestResult) => void;
  onRefresh: (provider: string) => void;
  onViewDetails: (connectionId: string) => void;
}

const SubscriptionHealthBanner: Component<Props> = (props) => {
  const issues = () =>
    props.rows.flatMap((row) => {
      const result = connectionTestResult(row.connection.id, props.health.get(row.connection.id));
      const issue = subscriptionIssue(row.connection, result);
      return issue ? [{ ...row, issue, result }] : [];
    });

  return (
    <Show when={issues().length > 0}>
      <section class="subscription-health" role="alert" aria-labelledby="subscription-health-title">
        <div class="subscription-health__heading">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m12 3 10 18H2L12 3Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
            <path
              d="M12 9v5m0 3v.01"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <h2 id="subscription-health-title">
            {issues().length === 1
              ? '1 subscription needs attention'
              : `${issues().length} subscriptions need attention`}
          </h2>
        </div>
        <ul class="subscription-health__list">
          <For each={issues()}>
            {(row) => (
              <li class="subscription-health__item">
                <div class="subscription-health__copy">
                  <strong>
                    {row.name} · {row.connection.label}
                  </strong>
                  <p>{row.issue.message}</p>
                </div>
                <div class="subscription-health__actions">
                  <Show when={row.issue.status !== 'refresh'}>
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      aria-label={`Check ${row.connection.label} again`}
                      disabled={isConnectionTestRunning(row.connection.id)}
                      onClick={() => void runConnectionTest(row.connection.id)}
                    >
                      {isConnectionTestRunning(row.connection.id) ? 'Checking…' : 'Check again'}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="btn btn--outline btn--sm"
                    aria-label={
                      row.issue.status === 'needs_reconnect'
                        ? `Relink ${row.connection.label}`
                        : row.issue.status === 'refresh'
                          ? `Refresh models for ${row.connection.label}`
                          : `View details for ${row.connection.label}`
                    }
                    disabled={
                      row.issue.status !== 'failed' &&
                      (!props.canManage || props.refreshingProvider !== null)
                    }
                    onClick={() => {
                      if (row.issue.status === 'needs_reconnect') {
                        props.onManage(row.provider, row.result);
                      } else if (row.issue.status === 'refresh') {
                        props.onRefresh(row.provider);
                      } else {
                        props.onViewDetails(row.connection.id);
                      }
                    }}
                  >
                    {row.issue.status === 'needs_reconnect'
                      ? 'Relink subscription'
                      : row.issue.status === 'refresh'
                        ? props.refreshingProvider === row.provider
                          ? 'Refreshing…'
                          : 'Refresh models'
                        : 'View details'}
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
};

export default SubscriptionHealthBanner;
