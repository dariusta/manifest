import { A } from '@solidjs/router';
import { Show, createEffect, createResource, createSignal, type Component } from 'solid-js';
import { getBillingStatus } from '../services/api/billing.js';
import { authClient } from '../services/auth-client.js';
import { formatBillingPrice } from '../services/billing-display.js';

const DISMISS_KEY = 'manifest_free_plan_ends_dismissed';
export const FREE_PLAN_ENDS_POST_URL = 'https://manifest.build/blog/manifest-cloud-paid/';

function isDismissed(key: string | null): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function dismiss(key: string | null): void {
  if (!key) return;
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* noop */
  }
}

/**
 * Shown to Cloud workspaces on the Free plan until the plan ends on
 * November 2, 2026. Pro workspaces never see it.
 */
const FreePlanEndsBanner: Component = () => {
  const session = authClient.useSession();
  const dismissKey = () => {
    const userId = session()?.data?.user?.id;
    return userId ? `${DISMISS_KEY}:${userId}` : null;
  };
  const [dismissed, setDismissed] = createSignal(false);
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });

  createEffect(() => setDismissed(isDismissed(dismissKey())));

  const onFreePlan = () => {
    const b = billing();
    return Boolean(b?.enabled && b.plan === 'free');
  };
  const price = () => formatBillingPrice(billing()?.priceMonthly) ?? '$19';

  const handleDismiss = () => {
    dismiss(dismissKey());
    setDismissed(true);
  };

  return (
    <Show when={onFreePlan() && !dismissed()}>
      <div class="free-plan-ends-banner" role="status">
        <span class="free-plan-ends-banner__text">
          The Free plan ends on November 2, 2026. From then, Manifest Cloud is {price()}/month with
          unlimited routed requests.{' '}
          <a
            href={FREE_PLAN_ENDS_POST_URL}
            class="free-plan-ends-banner__link"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the announcement
          </a>
        </span>
        <div class="free-plan-ends-banner__actions">
          <A
            href="/upgrade?reason=requests"
            class="btn btn--primary btn--sm free-plan-ends-banner__btn"
          >
            Subscribe
          </A>
          <button
            type="button"
            class="btn btn--outline btn--sm free-plan-ends-banner__btn"
            onClick={handleDismiss}
          >
            Got it
          </button>
        </div>
      </div>
    </Show>
  );
};

export default FreePlanEndsBanner;
