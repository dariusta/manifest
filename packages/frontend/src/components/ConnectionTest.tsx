import { Show, type Component } from 'solid-js';
import type { ConnectionTestStatus } from '../services/api.js';
import {
  connectionTestResult,
  isConnectionTestRunning,
  runConnectionTest,
} from '../services/connection-test-store.js';

interface Props {
  connectionId: string;
  /** Account name, used for the button's accessible label. */
  label: string;
  /** Parent view's in-flight flag (rename, disconnect, OAuth popup). */
  busy?: boolean;
}

const TONE: Record<ConnectionTestStatus, string> = {
  ok: 'connection-test__result--ok',
  failed: 'connection-test__result--failed',
  needs_reconnect: 'connection-test__result--failed',
  untestable: 'connection-test__result--muted',
};

const PREFIX: Record<ConnectionTestStatus, string> = {
  ok: 'Working',
  failed: 'Failed',
  needs_reconnect: 'Reconnect needed',
  untestable: 'Not testable',
};

/** The Test button. Pair with {@link ConnectionTestResultLine}. */
export const ConnectionTestButton: Component<Props> = (props) => (
  <button
    type="button"
    class="btn btn--outline btn--sm"
    style="flex-shrink: 0;"
    disabled={props.busy || isConnectionTestRunning(props.connectionId)}
    aria-label={`Test account ${props.label}`}
    onClick={() => void runConnectionTest(props.connectionId)}
  >
    <Show when={!isConnectionTestRunning(props.connectionId)} fallback={<span class="spinner" />}>
      Test
    </Show>
  </button>
);

/**
 * Result line for a connection test. Renders nothing until a test has run, so
 * it can sit unconditionally under the "Connected via …" subtitle.
 */
export const ConnectionTestResultLine: Component<{ connectionId: string }> = (props) => (
  <Show when={connectionTestResult(props.connectionId)}>
    {(result) => (
      <div
        class={`connection-test__result ${TONE[result().status]}`}
        role="status"
        data-status={result().status}
      >
        {PREFIX[result().status]} — {result().message}
      </div>
    )}
  </Show>
);
