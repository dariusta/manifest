import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

const mocks = vi.hoisted(() => ({
  getProviderPlanUsage: vi.fn(),
  setProviderManualUsageLimit: vi.fn(),
}));

vi.mock('@solidjs/meta', () => ({ Title: () => null }));
vi.mock('../../src/services/api/providers.js', () => ({
  getProviderPlanUsage: (...args: unknown[]) => mocks.getProviderPlanUsage(...args),
  setProviderManualUsageLimit: (...args: unknown[]) => mocks.setProviderManualUsageLimit(...args),
}));
vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: () => null,
}));

import PlanUsage from '../../src/pages/providers/PlanUsage';

const liveAnthropic = {
  tenant_provider_id: 'tp-anthropic',
  provider: 'anthropic',
  auth_type: 'subscription',
  label: 'Claude Max',
  is_active: true,
  connected_at: '2026-08-01T00:00:00.000Z',
  observed_30d: {
    requests: 12,
    tokens: 34000,
    estimated_cost_usd: 0,
    attempts: 12,
    succeeded: 11,
    success_rate: 91.666,
    last_used_at: '2026-09-01T12:00:00.000Z',
  },
  quota: {
    status: 'live',
    source: 'anthropic-oauth-usage',
    fetchedAt: '2026-09-02T01:00:00.000Z',
    planName: 'Claude Max',
    windows: [
      {
        name: '5-hour',
        usedPercent: 42,
        remainingPercent: 58,
        resetAt: '2026-09-02T06:00:00.000Z',
      },
    ],
  },
};

const unsupportedOpenAI = {
  tenant_provider_id: 'tp-openai-key',
  provider: 'openai',
  auth_type: 'api_key',
  label: 'Prod key',
  is_active: true,
  connected_at: '2026-07-01T00:00:00.000Z',
  observed_30d: {
    requests: 4,
    tokens: 800,
    estimated_cost_usd: 1.25,
    attempts: 4,
    succeeded: 4,
    success_rate: 100,
    last_used_at: null,
  },
  quota: {
    status: 'unsupported',
    source: 'none',
    fetchedAt: null,
    windows: [],
    message: 'Provider balance unavailable',
  },
};

const siblingAnthropic = {
  ...liveAnthropic,
  tenant_provider_id: 'tp-anthropic-2',
  label: 'Work Max',
};

beforeEach(() => {
  mocks.getProviderPlanUsage.mockReset();
  mocks.setProviderManualUsageLimit.mockReset();
  mocks.setProviderManualUsageLimit.mockResolvedValue({
    connectionId: 'tp-openai-key',
    limitUsd: 100,
  });
});

afterEach(() => {
  cleanup();
});

describe('Plan Usage page', () => {
  it('separates subscription plans from usage-based API keys', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [liveAnthropic, siblingAnthropic, unsupportedOpenAI],
    });
    render(() => <PlanUsage />);

    await screen.findByText('Work Max');
    expect(screen.getAllByText('Claude Max').length).toBeGreaterThan(0);
    expect(screen.queryByText('Prod key')).toBeNull();
    expect(screen.getByRole('tab', { name: /Subscriptions/ }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await fireEvent.click(screen.getByRole('tab', { name: /Usage-based API keys/ }));
    expect(await screen.findByText('Prod key')).toBeDefined();
    expect(screen.queryByText('Work Max')).toBeNull();
    expect(screen.getByText('Provider balance unavailable')).toBeDefined();
    expect(screen.queryByText('0 remaining')).toBeNull();
  });

  it('offers manual setup only when an API key has no automatic quota report', async () => {
    const liveApiKey = {
      ...unsupportedOpenAI,
      tenant_provider_id: 'tp-zai-key',
      provider: 'zai',
      label: 'Live key',
      quota: {
        status: 'live',
        source: 'zai-live',
        fetchedAt: '2026-09-02T01:00:00.000Z',
        windows: [{ name: 'credit limit', remainingPercent: 75 }],
      },
    };
    const unsupportedSubscription = {
      ...liveAnthropic,
      tenant_provider_id: 'tp-sub-unavailable',
      label: 'Private plan',
      quota: {
        status: 'unsupported',
        source: 'none',
        fetchedAt: null,
        windows: [],
      },
    };
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [unsupportedSubscription, unsupportedOpenAI, liveApiKey],
    });
    render(() => <PlanUsage />);

    await screen.findByText('Private plan');
    expect(screen.getByText('Usage unavailable')).toBeDefined();
    expect(screen.queryByText('Manual setup')).toBeNull();

    await fireEvent.click(screen.getByRole('tab', { name: /Usage-based API keys/ }));
    expect(await screen.findByText('Manual setup')).toBeDefined();
    expect(
      screen.getByRole('spinbutton', { name: 'Manual 30-day allowance for Prod key' }),
    ).toBeDefined();
    expect(
      screen.queryByRole('spinbutton', { name: 'Manual 30-day allowance for Live key' }),
    ).toBeNull();
  });

  it('lets an operator set a manual 30-day allowance on a usage-based key', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [liveAnthropic, unsupportedOpenAI],
    });
    render(() => <PlanUsage />);

    await screen.findByText('Claude Max');
    await fireEvent.click(screen.getByRole('tab', { name: /Usage-based API keys/ }));
    const input = screen.getByRole('spinbutton', { name: 'Manual 30-day allowance for Prod key' });
    await fireEvent.input(input, { target: { value: '100' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save allowance for Prod key' }));

    await waitFor(() =>
      expect(mocks.setProviderManualUsageLimit).toHaveBeenCalledWith('tp-openai-key', 100),
    );
  });

  it('clears the visible allowance after deleting a manual fallback', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...unsupportedOpenAI,
          manual_usage_limit_usd: 125.5,
          quota: {
            status: 'manual',
            source: 'manual',
            stale: false,
            fetchedAt: null,
            windows: [],
            balance: { limit: 125.5, used: 20, remaining: 105.5, unit: 'USD' },
          },
        },
      ],
    });
    render(() => <PlanUsage />);

    await fireEvent.click(await screen.findByRole('tab', { name: /Usage-based API keys/ }));
    const input = screen.getByRole('spinbutton', {
      name: 'Manual 30-day allowance for Prod key',
    }) as HTMLInputElement;
    expect(input.value).toBe('125.5');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear allowance for Prod key' }));

    await waitFor(() => {
      expect(mocks.setProviderManualUsageLimit).toHaveBeenCalledWith('tp-openai-key', null);
      expect(input.value).toBe('');
    });
  });

  it('rejects a non-positive manual allowance before saving', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({ connections: [unsupportedOpenAI] });
    render(() => <PlanUsage />);
    await screen.findByText('Prod key');
    const input = screen.getByRole('spinbutton', { name: 'Manual 30-day allowance for Prod key' });
    await fireEvent.input(input, { target: { value: '0' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save allowance for Prod key' }));
    await screen.findByText('Enter an allowance greater than $0.');
    expect(mocks.setProviderManualUsageLimit).not.toHaveBeenCalled();
  });

  it('surfaces save and clear failures inline', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [{ ...unsupportedOpenAI, manual_usage_limit_usd: 50 }],
    });
    mocks.setProviderManualUsageLimit
      .mockRejectedValueOnce(new Error('save boom'))
      .mockRejectedValueOnce('nope');
    render(() => <PlanUsage />);
    await screen.findByText('Prod key');
    await fireEvent.click(screen.getByRole('button', { name: 'Save allowance for Prod key' }));
    await screen.findByText('save boom');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear allowance for Prod key' }));
    await screen.findByText('Could not clear allowance');
  });

  it('shows an empty state when no connections exist', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({ connections: [] });
    render(() => <PlanUsage />);
    await screen.findByText('No connected plans yet');
  });

  it('shows a retryable error state', async () => {
    mocks.getProviderPlanUsage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ connections: [liveAnthropic] });
    render(() => <PlanUsage />);
    await screen.findByText('Something went wrong');
    await fireEvent.click(screen.getByText('Try again'));
    await screen.findByText('Claude Max');
  });

  it('refreshes all connections from the page action', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({ connections: [liveAnthropic] });
    render(() => <PlanUsage />);
    await screen.findByText('Claude Max');
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.getProviderPlanUsage).toHaveBeenCalledTimes(2));
    expect(mocks.getProviderPlanUsage.mock.calls[1][0]).toBeUndefined();
  });

  it('groups accounts per provider with Anthropic and OpenAI pinned first', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        { ...liveAnthropic, tenant_provider_id: 'tp-xai', provider: 'xai', label: 'Grok' },
        { ...liveAnthropic, tenant_provider_id: 'tp-openai-b', provider: 'openai', label: 'Team' },
        {
          ...liveAnthropic,
          tenant_provider_id: 'tp-gemini',
          provider: 'gemini',
          label: 'Google',
        },
        siblingAnthropic,
        { ...liveAnthropic, tenant_provider_id: 'tp-openai-a', provider: 'openai', label: 'Plus' },
        liveAnthropic,
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('Grok');

    const groups = [...document.querySelectorAll('.plan-usage-group')];
    expect(
      groups.map((group) => group.querySelector('.plan-usage-group__title')?.textContent),
    ).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI']);
    expect(
      groups.map((group) => group.querySelector('.plan-usage-group__count')?.textContent),
    ).toEqual(['2 accounts', '2 accounts', '1 account', '1 account']);
    // Every account gets its own card inside its provider group, A→Z by label.
    expect(
      groups.map((group) =>
        [...group.querySelectorAll('.plan-usage-card__label')].map((node) => node.textContent),
      ),
    ).toEqual([['Claude Max', 'Work Max'], ['Plus', 'Team'], ['Google'], ['Grok']]);
  });

  it('keeps Gemini 3.7 and Pro Agent usage visible and hides the rest until expanded', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...liveAnthropic,
          tenant_provider_id: 'tp-gemini',
          provider: 'gemini',
          label: 'Google',
          quota: {
            status: 'live',
            source: 'google_cloud_code_quota',
            fetchedAt: '2026-09-06T01:00:00.000Z',
            windows: [
              { name: 'gemini-2.5-flash', remainingPercent: 100 },
              { name: 'gemini-3.7-flash-tiered', remainingPercent: 100 },
              { name: 'gemini-pro-agent', remainingPercent: 100 },
              { name: 'gpt-oss-120b-medium', remainingPercent: 100 },
            ],
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('gemini-3.7-flash-tiered');
    expect(screen.getByText('gemini-pro-agent')).toBeDefined();
    expect(screen.queryByText('gemini-2.5-flash')).toBeNull();
    expect(screen.queryByText('gpt-oss-120b-medium')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Show 2 more models' }));
    expect(await screen.findByText('gemini-2.5-flash')).toBeDefined();
    expect(screen.getByText('gpt-oss-120b-medium')).toBeDefined();

    await fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('gemini-2.5-flash')).toBeNull();
  });

  it('pluralises the hidden-model toggle for a single extra window', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...liveAnthropic,
          tenant_provider_id: 'tp-gemini',
          provider: 'gemini',
          label: 'Google',
          quota: {
            status: 'live',
            source: 'google_cloud_code_quota',
            fetchedAt: '2026-09-06T01:00:00.000Z',
            windows: [
              { name: 'gemini-3.7-flash-tiered', remainingPercent: 100 },
              { name: 'gpt-oss-120b-medium', remainingPercent: 100 },
            ],
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('gemini-3.7-flash-tiered');
    expect(screen.getByRole('button', { name: 'Show 1 more model' })).toBeDefined();
  });

  it('renders subscription credits as a quiet detail row, not a headline', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...liveAnthropic,
          tenant_provider_id: 'tp-openai-sub',
          provider: 'openai',
          label: 'victor plus',
          quota: {
            status: 'cached',
            source: 'openai_codex_usage',
            fetchedAt: '2026-09-06T01:00:00.000Z',
            planName: 'plus',
            windows: [
              { name: '5-hour', remainingPercent: 100 },
              { name: '7-day', remainingPercent: 23 },
            ],
            balance: { remaining: 0, unit: 'USD' },
          },
        },
        {
          ...liveAnthropic,
          tenant_provider_id: 'tp-xai-sub',
          provider: 'xai',
          label: 'supergrok',
          quota: {
            status: 'cached',
            source: 'xai_subscription',
            fetchedAt: '2026-09-06T01:00:00.000Z',
            windows: [{ name: 'Weekly limit', remainingPercent: 11 }],
            balance: { remaining: 0, unit: 'credits' },
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('victor plus');

    // Plan tier shows as a capitalised chip beside the status badge.
    expect(screen.getByText('Plus')).toBeDefined();
    // Balance rows are labelled as extra credits and formatted per unit.
    expect(screen.getAllByText('Extra credits')).toHaveLength(2);
    const balances = [...document.querySelectorAll('.plan-usage-balance__value')].map(
      (el) => el.textContent,
    );
    expect(balances).toEqual(['$0.00', '0 credits']);
    expect(screen.queryByText(/USD remaining/)).toBeNull();
    expect(document.querySelector('.plan-usage-balance--headline')).toBeNull();

    // Bars are toned by how much is left.
    expect(document.querySelectorAll('.plan-usage-window--ok')).toHaveLength(1);
    expect(document.querySelectorAll('.plan-usage-window--warn')).toHaveLength(1);
    expect(document.querySelectorAll('.plan-usage-window--low')).toHaveLength(1);
  });

  it('renders a usage-based key balance as the headline', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...unsupportedOpenAI,
          quota: {
            status: 'live',
            source: 'openai_billing',
            fetchedAt: '2026-09-06T01:00:00.000Z',
            windows: [],
            balance: { remaining: 42.5, unit: 'USD' },
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('Prod key');
    expect(screen.getByText('Balance')).toBeDefined();
    expect(screen.getByText('$42.50')).toBeDefined();
    expect(document.querySelector('.plan-usage-balance--headline')).not.toBeNull();
  });

  it('labels windows that report counts instead of percentages', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...liveAnthropic,
          quota: {
            ...liveAnthropic.quota,
            windows: [
              { name: 'Monthly', remaining: 500, unit: 'requests' },
              { name: 'Daily', remaining: 5 },
              { name: 'Burst', used: 30, limit: 100 },
              { name: 'Flat', unit: 'unlimited' },
              { name: 'Unknown' },
            ],
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('Monthly');
    expect(screen.getByText('500 requests remaining')).toBeDefined();
    expect(screen.getByText('5 remaining')).toBeDefined();
    expect(screen.getByText('70 remaining')).toBeDefined();
    expect(screen.getByText('Unlimited')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
    // No percentage → neutral tone and no bar.
    expect(document.querySelectorAll('.plan-usage-window--ok')).toHaveLength(5);
    expect(document.querySelector('.plan-usage-bar')).toBeNull();
  });

  it('formats unlimited and multi-word plan names', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [
        {
          ...liveAnthropic,
          quota: {
            ...liveAnthropic.quota,
            planName: 'max_20x',
            balance: { unit: 'USD', unlimited: true },
          },
        },
      ],
    });
    render(() => <PlanUsage />);
    await screen.findByText('Max 20x');
    expect(screen.getByText('Unlimited')).toBeDefined();
  });
});
