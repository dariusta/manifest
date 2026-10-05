import { Show, type Component } from 'solid-js';
import { connectionTestResult } from '../services/connection-test-store.js';

interface Props {
  connectionId: string;
  label: string;
  busy?: boolean;
  onReconnect: (label: string) => void;
  /**
   * Render unconditionally as a "Replace" action that swaps this row's stored
   * credential in place (same label, so every harness keeps pointing at it).
   * Default keeps the old behavior: visible only after a connection test says
   * this account must sign in again.
   */
  always?: boolean;
}

/**
 * Re-sign-in for one account row. The provider sign-in overwrites that row's
 * stored credential instead of allocating a new account, so harnesses using
 * this connection keep working with no re-adding. Shown only after a
 * connection test says this account must sign in again, unless `always` opts
 * into the permanent "Replace" affordance. It never deletes the account or
 * allocates a new one.
 */
export const ReconnectAccountButton: Component<Props> = (props) => {
  const needsReconnect = connectionTestResult(props.connectionId)?.status === 'needs_reconnect';
  const visible = () => props.always || needsReconnect;
  const caption = () => (props.always && !needsReconnect ? 'Replace' : 'Reconnect');
  return (
    <Show when={visible()}>
      <button
        type="button"
        class="btn btn--outline btn--sm"
        style="flex-shrink: 0;"
        disabled={props.busy}
        aria-label={`${caption()} account ${props.label}`}
        title="Sign in again to replace this account's stored credential"
        onClick={() => props.onReconnect(props.label)}
      >
        {caption()}
      </button>
    </Show>
  );
};
