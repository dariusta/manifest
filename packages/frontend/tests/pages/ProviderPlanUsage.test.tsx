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
  mocks.setProviderManualUsageLimit.mockResolvedValue({ connectionId: 'tp-openai-key', limitUsd: 100 });
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
    expect(screen.getByRole('spinbutton', { name: 'Manual 30-day allowance for Prod key' })).toBeDefined();
    expect(
      screen.queryByRole('spinbutton', { name: 'Manual 30-day allowance for Live key' }),
    ).toBeNull();
  });

  it('lets an operator set a manual 30-day allowance on a usage-based key', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({ connections: [liveAnthropic, unsupportedOpenAI] });
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
    await screen.findByText('Anthropic');
  });

  it('refreshes all connections from the page action', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({ connections: [liveAnthropic] });
    render(() => <PlanUsage />);
    await screen.findByText('Anthropic');
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.getProviderPlanUsage).toHaveBeenCalledTimes(2));
    expect(mocks.getProviderPlanUsage.mock.calls[1][0]).toBeUndefined();
  });
});
