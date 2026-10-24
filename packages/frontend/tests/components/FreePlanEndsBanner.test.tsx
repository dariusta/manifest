import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import FreePlanEndsBanner, {
  FREE_PLAN_ENDS_POST_URL,
} from '../../src/components/FreePlanEndsBanner';

const mockGetBillingStatus = vi.fn();

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1' } },
      isPending: false,
    }),
  },
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

const freeStatus = (priceMonthly: unknown = null) => ({
  enabled: true,
  plan: 'free' as const,
  priceMonthly,
  requests: { used: 12, limit: 10_000, periodEnd: null },
});

describe('FreePlanEndsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGetBillingStatus.mockResolvedValue(freeStatus());
  });

  it('tells Free workspaces the plan ends and links the announcement', async () => {
    const { container } = render(() => <FreePlanEndsBanner />);

    await screen.findByText(/The Free plan ends on November 2, 2026/);
    expect(container.querySelector('.free-plan-ends-banner__text')!.textContent).toContain(
      '$19/month',
    );
    const link = container.querySelector('.free-plan-ends-banner__link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(FREE_PLAN_ENDS_POST_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('a[href="/upgrade?reason=requests"]')!.textContent).toBe(
      'Subscribe',
    );
  });

  it('uses the Stripe price when billing carries one', async () => {
    mockGetBillingStatus.mockResolvedValue(
      freeStatus({ amount: 29, currency: 'usd', interval: 'month' }),
    );
    const { container } = render(() => <FreePlanEndsBanner />);

    await screen.findByText(/The Free plan ends on November 2, 2026/);
    expect(container.querySelector('.free-plan-ends-banner__text')!.textContent).toContain(
      '$29/month',
    );
  });

  it('dismisses for this user only and remembers it', async () => {
    const { container } = render(() => <FreePlanEndsBanner />);
    await screen.findByText(/The Free plan ends on November 2, 2026/);

    fireEvent.click(screen.getByText('Got it'));

    await waitFor(() => {
      expect(container.querySelector('.free-plan-ends-banner')).toBeNull();
    });
    expect(localStorage.getItem('manifest_free_plan_ends_dismissed:u1')).toBe('1');
  });

  it('stays hidden once dismissed', async () => {
    localStorage.setItem('manifest_free_plan_ends_dismissed:u1', '1');
    const { container } = render(() => <FreePlanEndsBanner />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());

    expect(container.querySelector('.free-plan-ends-banner')).toBeNull();
  });

  it('does not reuse another user dismissal', async () => {
    localStorage.setItem('manifest_free_plan_ends_dismissed:u2', '1');
    render(() => <FreePlanEndsBanner />);

    await screen.findByText(/The Free plan ends on November 2, 2026/);
  });

  it('keeps working when dismissal storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    try {
      render(() => <FreePlanEndsBanner />);

      await screen.findByText(/The Free plan ends on November 2, 2026/);
      expect(() => fireEvent.click(screen.getByText('Got it'))).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('stays hidden for Pro users, self-hosted installs and billing failures', async () => {
    mockGetBillingStatus.mockResolvedValueOnce({
      enabled: true,
      plan: 'pro',
      requests: { used: null, limit: null, periodEnd: null },
    });
    const pro = render(() => <FreePlanEndsBanner />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(1));
    expect(pro.container.querySelector('.free-plan-ends-banner')).toBeNull();
    pro.unmount();

    mockGetBillingStatus.mockResolvedValueOnce({ enabled: false, plan: 'free', requests: {} });
    const selfHosted = render(() => <FreePlanEndsBanner />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(2));
    expect(selfHosted.container.querySelector('.free-plan-ends-banner')).toBeNull();
    selfHosted.unmount();

    mockGetBillingStatus.mockRejectedValueOnce(new Error('network'));
    const failed = render(() => <FreePlanEndsBanner />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(3));
    expect(failed.container.querySelector('.free-plan-ends-banner')).toBeNull();
  });
});
