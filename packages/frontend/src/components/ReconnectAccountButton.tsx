import { Show, type Component } from 'solid-js';
import { connectionTestResult } from '../services/connection-test-store.js';

interface Props {
  connectionId: string;
  label: string;
  busy?: boolean;
  onReconnect: (label: string) => void;
}

/**
 * Shown only after a connection test says this account must sign in again.
 * The click re-runs that provider's sign-in against this row; it does not
 * delete the account or allocate a new one.
 */
export const ReconnectAccountButton: Component<Props> = (props) => (
  <Show when={connectionTestResult(props.connectionId)?.status === 'needs_reconnect'}>
    <button
      type="button"
      class="btn btn--outline btn--sm"
      style="flex-shrink: 0;"
      disabled={props.busy}
      aria-label={`Reconnect account ${props.label}`}
      title="Sign in again to replace this account's stored credential"
      onClick={() => props.onReconnect(props.label)}
    >
      Reconnect
    </button>
  </Show>
);
