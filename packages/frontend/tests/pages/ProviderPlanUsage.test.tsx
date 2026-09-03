import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

const mocks = vi.hoisted(() => ({
  getProviderPlanUsage: vi.fn(),
}));

vi.mock('@solidjs/meta', () => ({ Title: () => null }));
vi.mock('../../src/services/api/providers.js', () => ({
  getProviderPlanUsage: (...args: unknown[]) => mocks.getProviderPlanUsage(...args),
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
});

afterEach(() => {
  cleanup();
});

describe('Plan Usage page', () => {
  it('renders one card per connection and keeps same-provider keys distinct', async () => {
    mocks.getProviderPlanUsage.mockResolvedValue({
      connections: [liveAnthropic, siblingAnthropic, unsupportedOpenAI],
    });
    render(() => <PlanUsage />);

    await screen.findByText('Work Max');
    expect(screen.getAllByText('Claude Max').length).toBeGreaterThan(0);
    expect(screen.getByText('Prod key')).toBeDefined();
    expect(screen.getAllByText(/Anthropic|Claude/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('5-hour').length).toBe(2);
    expect(screen.getAllByText('58% remaining').length).toBe(2);
    expect(screen.getByText('Provider balance unavailable')).toBeDefined();
    expect(screen.queryByText('0 remaining')).toBeNull();
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
