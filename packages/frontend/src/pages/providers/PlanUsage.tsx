import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type Component,
} from 'solid-js';
import { Title } from '@solidjs/meta';
import ErrorState from '../../components/ErrorState.jsx';
import { providerIcon } from '../../components/ProviderIcon.jsx';
import {
  getProviderPlanUsage,
  setProviderManualUsageLimit,
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
  manual: 'Manual',
  unavailable: 'Usage unavailable',
  unsupported: 'Usage unavailable',
  needs_reconnect: 'Needs reconnect',
};

function statusLabel(row: ProviderPlanUsage): string {
  if (row.quota.status === 'unsupported' && row.auth_type === 'api_key') return 'Manual setup';
  return STATUS_LABEL[row.quota.status];
}

function canSetManualAllowance(row: ProviderPlanUsage): boolean {
  return (
    row.auth_type === 'api_key' &&
    (row.quota.status === 'manual' ||
      row.quota.status === 'unsupported' ||
      row.quota.status === 'unavailable')
  );
}

type UsageTab = 'subscription' | 'api_key';

function providerName(id: string): string {
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? id;
}

/** Providers pinned to the top of the page, in this order; the rest follow A→Z. */
const PINNED_PROVIDERS = ['anthropic', 'openai'];

function providerRank(id: string): number {
  const index = PINNED_PROVIDERS.indexOf(id);
  return index === -1 ? PINNED_PROVIDERS.length : index;
}

function byProviderName(a: ProviderPlanUsage, b: ProviderPlanUsage): number {
  return (
    providerRank(a.provider) - providerRank(b.provider) ||
    providerName(a.provider).localeCompare(providerName(b.provider)) ||
    a.label.localeCompare(b.label)
  );
}

interface ProviderGroup {
  provider: string;
  rows: ProviderPlanUsage[];
}

/** Rows are already sorted, so consecutive runs of one provider form a group. */
function groupByProvider(rows: ProviderPlanUsage[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.provider === row.provider) last.rows.push(row);
    else groups.push({ provider: row.provider, rows: [row] });
  }
  return groups;
}

const GEMINI_FEATURED_WINDOW = /gemini-3\.7|gemini-pro-agent/i;

function isGeminiConnection(row: ProviderPlanUsage): boolean {
  return row.provider === 'gemini' || row.provider === 'google';
}

function isFeaturedGeminiWindow(window: ProviderPlanUsageWindow): boolean {
  return GEMINI_FEATURED_WINDOW.test(window.name);
}

function clampPercent(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function formatReset(value?: string): string | null {
  return value ? formatTime(value, { seconds: false }) : null;
}

/** Bar/label tone for a window so a nearly-spent allowance stands out. */
function windowTone(window: ProviderPlanUsageWindow): 'ok' | 'warn' | 'low' {
  const remaining = clampPercent(window.remainingPercent);
  if (remaining == null) return 'ok';
  if (remaining <= 15) return 'low';
  if (remaining <= 35) return 'warn';
  return 'ok';
}

/** Plan tiers come back lower-cased from providers (`plus`, `team`, `max_20x`). */
function formatPlanName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatBalanceAmount(balance: { remaining: number; unit: string }): string {
  if (balance.unit === 'USD') return formatCost(balance.remaining) ?? '$0.00';
  return `${formatNumber(balance.remaining)} ${balance.unit}`;
}

function windowRemainingLabel(window: ProviderPlanUsageWindow): string | null {
  if (window.unit === 'unlimited') return 'Unlimited';
  if (window.remaining != null && window.unit) {
    return `${formatNumber(window.remaining)} ${window.unit} remaining`;
  }
  const remaining = clampPercent(window.remainingPercent);
  if (remaining != null) return `${Math.round(remaining)}% remaining`;
  if (window.remaining != null) return `${formatNumber(window.remaining)} remaining`;
  if (window.used != null && window.limit != null) {
    return `${formatNumber(Math.max(0, window.limit - window.used))} remaining`;
  }
  return null;
}

function balanceRemainingLabel(row: ProviderPlanUsage): string | null {
  // Manual quota already renders the allowance as its window; showing the same
  // number again as a balance line would duplicate it.
  if (row.quota.status === 'manual') return null;
  const balance = row.quota.balance;
  if (!balance) return null;
  if (balance.unlimited) return 'Unlimited';
  if (balance.remaining == null) return null;
  return formatBalanceAmount({ remaining: balance.remaining, unit: balance.unit });
}

/**
 * On a subscription the balance is the prepaid / extra-usage credit pool on
 * top of the plan, which is $0 for most people — so it reads as a quiet
 * detail row, not the headline. On a usage-based key it *is* the allowance.
 */
function balanceHeading(row: ProviderPlanUsage): string {
  return row.auth_type === 'subscription' ? 'Extra credits' : 'Balance';
}

const PlanUsage: Component = () => {
  const [loadError, setLoadError] = createSignal<unknown>(null);
  const [activeTab, setActiveTab] = createSignal<UsageTab>('subscription');
  // Land on the first tab that actually has data; preserve explicit switches.
  const [userPickedTab, setUserPickedTab] = createSignal(false);
  createEffect(() => {
    if (userPickedTab() || data.loading) return;
    if (activeTab() === 'subscription' && subscriptions().length === 0 && usageBased().length > 0) {
      setActiveTab('api_key');
    }
  });
  const selectTab = (tab: UsageTab) => {
    setUserPickedTab(true);
    setActiveTab(tab);
  };
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
  const subscriptions = createMemo(() =>
    connections()
      .filter((row) => row.auth_type === 'subscription')
      .slice()
      .sort(byProviderName),
  );
  const usageBased = createMemo(() =>
    connections()
      .filter((row) => row.auth_type === 'api_key')
      .slice()
      .sort(byProviderName),
  );
  const visibleConnections = createMemo(() =>
    activeTab() === 'subscription' ? subscriptions() : usageBased(),
  );
  const visibleGroups = createMemo(() => groupByProvider(visibleConnections()));
  // Manual allowances are operator-entered estimates, not provider telemetry;
  // counting them would overstate live provider reports.
  const liveCount = createMemo(
    () => connections().filter((row) => ['live', 'cached'].includes(row.quota.status)).length,
  );
  const attentionCount = createMemo(
    () => connections().filter((row) => row.quota.status === 'needs_reconnect').length,
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

        <div class="panel__tabs plan-usage-tabs" role="tablist" aria-label="Plan usage type">
          <button
            type="button"
            role="tab"
            class="panel__tab"
            classList={{ 'panel__tab--active': activeTab() === 'subscription' }}
            aria-selected={activeTab() === 'subscription'}
            onClick={() => selectTab('subscription')}
          >
            Subscriptions ({subscriptions().length})
          </button>
          <button
            type="button"
            role="tab"
            class="panel__tab"
            classList={{ 'panel__tab--active': activeTab() === 'api_key' }}
            aria-selected={activeTab() === 'api_key'}
            onClick={() => selectTab('api_key')}
          >
            Usage-based API keys ({usageBased().length})
          </button>
        </div>

        <Show
          when={visibleConnections().length > 0}
          fallback={
            <div class="empty-state plan-usage-tab-empty">
              <div class="empty-state__title">
                {activeTab() === 'subscription'
                  ? 'No subscriptions connected'
                  : 'No usage-based API keys connected'}
              </div>
            </div>
          }
        >
          <For each={visibleGroups()}>
            {(group) => (
              <section class="plan-usage-group" aria-label={providerName(group.provider)}>
                <div class="plan-usage-group__header">
                  {providerIcon(group.provider, 18)}
                  <h2 class="plan-usage-group__title">{providerName(group.provider)}</h2>
                  <span class="plan-usage-group__count">
                    {group.rows.length} {group.rows.length === 1 ? 'account' : 'accounts'}
                  </span>
                </div>
                <div class="plan-usage-grid">
                  <For each={group.rows}>
                    {(row) => (
                      <PlanUsageCard
                        row={row}
                        onSaved={() => {
                          void refetch();
                        }}
                      />
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};

const PlanUsageCard: Component<{ row: ProviderPlanUsage; onSaved: () => void }> = (props) => {
  const observed = () => props.row.observed_30d;
  const quota = () => props.row.quota;
  // Seed from the configured limit (independent of the effective quota) so a
  // stored allowance stays visible and clearable even while live/cached
  // provider data is authoritative.
  const [manualLimit, setManualLimit] = createSignal(
    props.row.manual_usage_limit_usd != null ? String(props.row.manual_usage_limit_usd) : '',
  );
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [showMoreWindows, setShowMoreWindows] = createSignal(false);
  const featuredWindows = createMemo(() => {
    const windows = quota().windows;
    if (!isGeminiConnection(props.row)) return windows;
    return windows.filter(isFeaturedGeminiWindow);
  });
  const extraWindows = createMemo(() => {
    if (!isGeminiConnection(props.row)) return [];
    return quota().windows.filter((window) => !isFeaturedGeminiWindow(window));
  });
  const visibleWindows = createMemo(() =>
    showMoreWindows() ? [...featuredWindows(), ...extraWindows()] : featuredWindows(),
  );

  const saveManualLimit = async () => {
    const value = Number(manualLimit());
    if (!Number.isFinite(value) || value <= 0) {
      setSaveError('Enter an allowance greater than $0.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await setProviderManualUsageLimit(props.row.tenant_provider_id, value);
      props.onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save allowance');
    } finally {
      setSaving(false);
    }
  };

  const clearManualLimit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await setProviderManualUsageLimit(props.row.tenant_provider_id, null);
      setManualLimit('');
      props.onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not clear allowance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="panel plan-usage-card">
      <div class="plan-usage-card__header">
        <div class="plan-usage-card__identity">
          {providerIcon(props.row.provider, 20)}
          <div class="plan-usage-card__identity-text">
            <div class="plan-usage-card__name">{providerName(props.row.provider)}</div>
            <div class="plan-usage-card__label" title={props.row.label}>
              {props.row.label}
            </div>
          </div>
        </div>
        <div class="plan-usage-card__badges">
          <Show when={quota().planName && quota().planName !== props.row.label}>
            <span class="plan-usage-plan">{formatPlanName(quota().planName!)}</span>
          </Show>
          <span class={`plan-usage-badge plan-usage-badge--${quota().status}`}>
            {statusLabel(props.row)}
          </span>
        </div>
      </div>

      <div class="plan-usage-card__body">
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
          <For each={visibleWindows()}>
            {(window) => (
              <div class={`plan-usage-window plan-usage-window--${windowTone(window)}`}>
                <div class="plan-usage-window__meta">
                  <span class="plan-usage-window__name" title={window.name}>
                    {window.name}
                  </span>
                  <span class="plan-usage-window__remaining">
                    {windowRemainingLabel(window) ?? '—'}
                  </span>
                </div>
                <Show when={clampPercent(window.remainingPercent) != null}>
                  <div class="plan-usage-bar" aria-hidden="true">
                    <div
                      class="plan-usage-bar__fill"
                      style={{ width: `${clampPercent(window.remainingPercent)}%` }}
                    />
                  </div>
                </Show>
                <Show when={formatReset(window.resetAt)}>
                  {(reset) => <div class="plan-usage-window__reset">Resets {reset()}</div>}
                </Show>
              </div>
            )}
          </For>
          <Show when={extraWindows().length > 0}>
            <button
              class="plan-usage-more"
              type="button"
              aria-expanded={showMoreWindows()}
              onClick={() => setShowMoreWindows(!showMoreWindows())}
            >
              {showMoreWindows()
                ? 'Show less'
                : `Show ${extraWindows().length} more model${extraWindows().length === 1 ? '' : 's'}`}
            </button>
          </Show>
        </Show>

        <Show when={balanceRemainingLabel(props.row)}>
          {(remaining) => (
            <div
              class="plan-usage-balance"
              classList={{ 'plan-usage-balance--headline': props.row.auth_type === 'api_key' }}
            >
              <span class="plan-usage-balance__label">{balanceHeading(props.row)}</span>
              <span class="plan-usage-balance__value">{remaining()}</span>
            </div>
          )}
        </Show>

        <Show when={canSetManualAllowance(props.row)}>
          <div class="plan-usage-manual-limit">
            <label for={`manual-limit-${props.row.tenant_provider_id}`}>
              Manual 30-day allowance (USD)
            </label>
            <div class="plan-usage-manual-limit__controls">
              <input
                id={`manual-limit-${props.row.tenant_provider_id}`}
                class="input"
                type="number"
                min="0.01"
                step="0.01"
                value={manualLimit()}
                aria-label={`Manual 30-day allowance for ${props.row.label}`}
                placeholder="e.g. 100"
                onInput={(event) => setManualLimit(event.currentTarget.value)}
              />
              <button
                class="btn btn--outline btn--sm"
                type="button"
                disabled={saving()}
                aria-label={`Save allowance for ${props.row.label}`}
                onClick={() => void saveManualLimit()}
              >
                Save
              </button>
              <Show when={props.row.manual_usage_limit_usd != null}>
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  disabled={saving()}
                  aria-label={`Clear allowance for ${props.row.label}`}
                  onClick={() => void clearManualLimit()}
                >
                  Clear
                </button>
              </Show>
            </div>
            <p class="plan-usage-message">
              Remaining allowance is the amount you enter minus Manifest-tracked cost over the last
              30 days.
            </p>
            <Show when={saveError()}>{(message) => <p class="form-error">{message()}</p>}</Show>
          </div>
        </Show>
      </div>

      <dl class="plan-usage-observed">
        <div>
          <dt>Requests (30d)</dt>
          <dd>{formatNumber(observed().requests)}</dd>
        </div>
        <div>
          <dt>Tokens (30d)</dt>
          <dd>{formatNumber(observed().tokens)}</dd>
        </div>
        <div>
          <dt>Cost (30d)</dt>
          <dd>{formatCost(observed().estimated_cost_usd) ?? '—'}</dd>
        </div>
        <div>
          <dt>Success</dt>
          <dd>
            {(() => {
              const rate = observed().success_rate;
              return rate == null ? '—' : `${rate.toFixed(1)}%`;
            })()}
          </dd>
        </div>
      </dl>
    </section>
  );
};

export default PlanUsage;
