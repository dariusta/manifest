import { For, Show, createMemo, createResource, createSignal, type Component } from 'solid-js';
import { Title } from '@solidjs/meta';
import ErrorState from '../../components/ErrorState.jsx';
import { providerIcon } from '../../components/ProviderIcon.jsx';
import {
  getProviderPlanUsage,
  type ProviderPlanUsage,
  type ProviderPlanUsageStatus,
  type ProviderPlanUsageWindow,
} from '../../services/api/providers.js';
import { formatCost, formatNumber, formatTime } from '../../services/formatters.js';
import { PROVIDERS } from '../../services/providers.js';
import '../../styles/analytics-overview.css';
import '../../styles/plan-usage.css';

const STATUS_LABEL: Record<ProviderPlanUsageStatus, string> = {
  live: 'Live',
  cached: 'Cached',
  unavailable: 'Unavailable',
  unsupported: 'Unsupported',
  needs_reconnect: 'Needs reconnect',
};

function providerName(id: string): string {
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? id;
}

function clampPercent(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function formatReset(value?: string): string | null {
  return value ? formatTime(value) : null;
}

function windowRemainingLabel(window: ProviderPlanUsageWindow): string | null {
  const remaining = clampPercent(window.remainingPercent);
  if (remaining != null) return `${Math.round(remaining)}% remaining`;
  if (window.remaining != null && window.unit) {
    return `${formatNumber(window.remaining)} ${window.unit} remaining`;
  }
  if (window.remaining != null) return `${formatNumber(window.remaining)} remaining`;
  if (window.used != null && window.limit != null) {
    return `${formatNumber(Math.max(0, window.limit - window.used))} remaining`;
  }
  return null;
}

const PlanUsage: Component = () => {
  const [loadError, setLoadError] = createSignal<unknown>(null);
  const [data, { refetch }] = createResource(async () => {
    try {
      const result = await getProviderPlanUsage();
      setLoadError(null);
      return result;
    } catch (error) {
      setLoadError(error);
      return { connections: [] };
    }
  });
  const connections = createMemo(() => data()?.connections ?? []);
  const liveCount = createMemo(
    () =>
      connections().filter((row) => row.quota.status === 'live' || row.quota.status === 'cached')
        .length,
  );
  const attentionCount = createMemo(
    () =>
      connections().filter((row) => ['unavailable', 'needs_reconnect'].includes(row.quota.status))
        .length,
  );

  return (
    <div class="container--lg">
      <Title>Plan Usage | Manifest</Title>
      <div class="page-header">
        <div>
          <h1 class="page-header__title">Plan Usage</h1>
          <p class="page-header__subtitle">
            Remaining allowance for every connected plan and usage-based key.
          </p>
        </div>
        <button class="btn btn--outline btn--sm" type="button" onClick={() => refetch()}>
          Refresh
        </button>
      </div>

      <Show when={data.loading && !loadError()}>
        <div class="skeleton" style="height: 180px; margin-bottom: 24px;" />
      </Show>

      <Show when={loadError()}>
        <ErrorState error={loadError()} onRetry={() => refetch()} />
      </Show>

      <Show when={!data.loading && !loadError() && connections().length === 0}>
        <div class="empty-state">
          <div class="empty-state__title">No connected plans yet</div>
          <p>Connect a subscription or usage-based key to see remaining allowance here.</p>
        </div>
      </Show>

      <Show when={!data.loading && !loadError() && connections().length > 0}>
        <div
          class="overview-stats"
          style="grid-template-columns: repeat(3, 1fr); margin-bottom: 24px;"
        >
          <div class="overview-stat-card">
            <span class="overview-stat-card__label">Connections</span>
            <div class="overview-stat-card__value-row">
              <span class="overview-stat-card__value">{connections().length}</span>
            </div>
          </div>
          <div class="overview-stat-card">
            <span class="overview-stat-card__label">Live provider reports</span>
            <div class="overview-stat-card__value-row">
              <span class="overview-stat-card__value">{liveCount()}</span>
            </div>
          </div>
          <div class="overview-stat-card">
            <span class="overview-stat-card__label">Needs attention</span>
            <div class="overview-stat-card__value-row">
              <span class="overview-stat-card__value">{attentionCount()}</span>
            </div>
          </div>
        </div>

        <div class="plan-usage-grid">
          <For each={connections()}>{(row) => <PlanUsageCard row={row} />}</For>
        </div>
      </Show>
    </div>
  );
};

const PlanUsageCard: Component<{ row: ProviderPlanUsage }> = (props) => {
  const observed = () => props.row.observed_30d;
  const quota = () => props.row.quota;

  return (
    <section class="panel plan-usage-card">
      <div class="plan-usage-card__header">
        <div class="plan-usage-card__identity">
          {providerIcon(props.row.provider, 20)}
          <div>
            <div class="plan-usage-card__name">{providerName(props.row.provider)}</div>
            <div class="plan-usage-card__label">{props.row.label}</div>
          </div>
        </div>
        <span class={`plan-usage-badge plan-usage-badge--${quota().status}`}>
          {STATUS_LABEL[quota().status]}
        </span>
      </div>

      <Show when={quota().planName && quota().planName !== props.row.label}>
        <div class="plan-usage-card__label">{quota().planName}</div>
      </Show>

      <Show
        when={quota().windows.length > 0}
        fallback={
          <p class="plan-usage-message">
            {quota().message ??
              (quota().status === 'unsupported' || quota().status === 'unavailable'
                ? 'Provider balance unavailable'
                : null)}
          </p>
        }
      >
        <For each={quota().windows}>
          {(window) => (
            <div class="plan-usage-window">
              <div class="plan-usage-window__meta">
                <span>{window.name}</span>
                <span>{windowRemainingLabel(window) ?? '—'}</span>
              </div>
              <Show when={clampPercent(window.remainingPercent) != null}>
                <div class="model-bar__track" aria-hidden="true">
                  <div
                    class="model-bar__fill"
                    style={{ width: `${clampPercent(window.remainingPercent)}%` }}
                  />
                </div>
              </Show>
              <Show when={formatReset(window.resetAt)}>
                {(reset) => <div class="plan-usage-message">Resets {reset()}</div>}
              </Show>
            </div>
          )}
        </For>
      </Show>

      <div class="plan-usage-observed">
        <div>Requests (30d): {formatNumber(observed().requests)}</div>
        <div>Tokens (30d): {formatNumber(observed().tokens)}</div>
        <div>Cost (30d): {formatCost(observed().estimated_cost_usd) ?? '—'}</div>
        <div>
          Success:{' '}
          {(() => {
            const rate = observed().success_rate;
            return rate == null ? '—' : `${rate.toFixed(1)}%`;
          })()}
        </div>
      </div>
    </section>
  );
};

export default PlanUsage;
