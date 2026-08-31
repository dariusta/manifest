import {
  createEffect,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import {
  startAnthropicOAuth,
  submitAnthropicOAuth,
  revokeAnthropicOAuth,
  getAnthropicAuthorizationCode,
  getAnthropicOAuthPending,
  renameProviderKey,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import CopyButton from './CopyButton.js';

interface Props {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  connected: Accessor<boolean>;
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  onBack: () => void;
  onUpdate: () => void;
  onClose: () => void;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  activeKeys?: Accessor<RoutingProvider[]>;
}

const MAX_LABEL_LENGTH = 50;
/** Mirrors MAX_KEYS_PER_PROVIDER in the backend's provider.service.ts. */
const MAX_CONNECTIONS_PER_PROVIDER = 5;

/**
 * Anthropic subscription connect view. Sign in with Claude opens an OAuth
 * popup; the user pastes the resulting `<code>#<state>` payload back into
 * the input. Tokens are stored as refreshable JSON blobs and rotated by
 * the proxy automatically on every request.
 *
 * The sign-in button and paste field stay on screen once a subscription is
 * connected — pasting a fresh code is how a second account gets added, and
 * gating the field behind an "adding" flag stranded users with a copied code
 * and nowhere to put it whenever the popup was blocked or authorize failed.
 */
const AnthropicOAuthDetailView: Component<Props> = (props) => {
  const [state, setState] = createSignal<string | null>(null);
  const [input, setInput] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [expandedAccountId, setExpandedAccountId] = createSignal<string | null>(null);
  const [authorizationCode, setAuthorizationCode] = createSignal('');
  const [credentialLoading, setCredentialLoading] = createSignal(false);
  const [credentialError, setCredentialError] = createSignal<string | null>(null);

  const connectionCount = () => (props.activeKeys?.() ?? []).length;
  const isMultiKey = () => connectionCount() > 1;
  const hasAccountRows = () => connectionCount() > 0;
  // The exchange is rejected past the cap, so stop offering the form there
  // rather than letting the paste fail server-side.
  const showConnectForm = () =>
    !props.connected() || connectionCount() < MAX_CONNECTIONS_PER_PROVIDER;

  // "Add connection" in the header only has to launch the popup — the paste
  // field below is already rendered.
  createEffect(() => {
    if (props.addKeyOpen?.() && props.connected() && !props.busy()) {
      props.setAddKeyOpen?.(false);
      void handleSignIn();
    }
  });

  // Restore any pending OAuth flow so the paste field still works after the
  // modal was closed mid-dance.
  onMount(async () => {
    if (props.connected()) return;
    try {
      const { state: pending } = await getAnthropicOAuthPending(props.agentName);
      if (pending) setState(pending);
    } catch {
      // Missing pending state just means the user hasn't started a flow yet.
    }
  });

  const handleSignIn = async () => {
    setError(null);
    // Open synchronously while the click still has user activation. Browsers
    // can block a window opened after the OAuth start request completes.
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      toast.error('Popup was blocked by your browser. Allow popups for this site, then try again.');
      return;
    }
    // The blank page is same-origin, so remove its access to the dashboard
    // before navigating it to Anthropic.
    popup.opener = null;

    props.setBusy(true);
    try {
      const { url, state: authState } = await startAnthropicOAuth(props.agentName);
      setState(authState);
      if (!popup.closed) popup.location.replace(url);
    } catch {
      popup.close();
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleSubmit = async () => {
    const raw = input().trim().replace(/\s/g, '');
    if (!raw) return;

    if (!raw.includes('#')) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }
    const pastedState = raw.slice(raw.indexOf('#') + 1);
    if (!pastedState) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }

    // Read before the exchange: `connected` flips once onUpdate refreshes.
    const wasConnected = props.connected();
    props.setBusy(true);
    setError(null);
    try {
      const authState = state() ?? pastedState;
      await submitAnthropicOAuth(props.agentName, raw, authState);
      toast.success(
        wasConnected
          ? `${props.provDef.name} connection added`
          : `${props.provDef.name} subscription connected`,
      );
      setInput('');
      setState(null);
      props.onUpdate();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to exchange code. The code may have expired. Sign in again to retry.',
      );
    } finally {
      props.setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleDeleteKey = async (label: string) => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName, label);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const startRename = (k: RoutingProvider) => {
    setRenamingId(k.id);
    setRenameValue(k.label);
  };

  const toggleAccountCredential = async (k: RoutingProvider) => {
    if (expandedAccountId() === k.id) {
      setExpandedAccountId(null);
      setAuthorizationCode('');
      setCredentialError(null);
      return;
    }

    setExpandedAccountId(k.id);
    setAuthorizationCode('');
    setCredentialError(null);
    setCredentialLoading(true);
    try {
      const result = await getAnthropicAuthorizationCode(props.agentName, k.label);
      // Ignore a response from a row the user collapsed while the request was in flight.
      if (expandedAccountId() === k.id) {
        setAuthorizationCode(result.authorizationCode);
      }
    } catch (err) {
      if (expandedAccountId() === k.id) {
        setCredentialError(
          err instanceof Error ? err.message : 'Unable to reveal this account credential.',
        );
      }
    } finally {
      if (expandedAccountId() === k.id) {
        setCredentialLoading(false);
      }
    }
  };

  const commitRename = async (k: RoutingProvider) => {
    const newLabel = renameValue().trim();
    if (!newLabel || newLabel === k.label) {
      setRenamingId(null);
      return;
    }
    props.setBusy(true);
    try {
      await renameProviderKey(
        props.agentName,
        props.provId,
        k.label,
        newLabel,
        props.selectedAuthType(),
      );
      toast.success(`Renamed to "${newLabel}"`);
      setRenamingId(null);
      props.onUpdate();
    } catch {
      // toast handled upstream
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <>
      <Show when={props.connected()}>
        {/* Connected account list. Credentials load only after an explicit row click. */}
        <Show when={hasAccountRows()}>
          <div class="provider-detail__field">
            <label class="provider-detail__label">Accounts</label>
            <ul
              class="anthropic-account-list"
              role="list"
              aria-label={`OAuth accounts for ${props.provDef.name}`}
            >
              <For each={props.activeKeys!()}>
                {(k) => (
                  <li class="anthropic-account">
                    <Show
                      when={renamingId() === k.id}
                      fallback={
                        <div class="anthropic-account__row">
                          <button
                            type="button"
                            class="anthropic-account__trigger"
                            aria-label={`View authorization code for ${k.label}`}
                            aria-expanded={expandedAccountId() === k.id}
                            aria-controls={`anthropic-account-credential-${k.id}`}
                            disabled={props.busy()}
                            onClick={() => void toggleAccountCredential(k)}
                          >
                            <span class="anthropic-account__summary">
                              <span class="anthropic-account__name">{k.label}</span>
                              <span class="anthropic-account__subtitle">
                                Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
                              </span>
                            </span>
                            <svg
                              class="anthropic-account__chevron"
                              classList={{
                                'anthropic-account__chevron--expanded':
                                  expandedAccountId() === k.id,
                              }}
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                          </button>
                          <div class="anthropic-account__actions">
                            <button
                              class="btn btn--outline btn--sm"
                              disabled={props.busy()}
                              onClick={() => startRename(k)}
                            >
                              Rename
                            </button>
                            <button
                              class="provider-detail__disconnect-icon"
                              disabled={props.busy()}
                              onClick={() => handleDeleteKey(k.label)}
                              aria-label={`Delete account ${k.label}`}
                              title="Delete account"
                            >
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M3 6h18" />
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      }
                    >
                      <div class="anthropic-account__rename">
                        <input
                          class="provider-detail__input"
                          type="text"
                          maxlength={MAX_LABEL_LENGTH}
                          aria-label={`Rename ${k.label}`}
                          value={renameValue()}
                          onInput={(e) => setRenameValue(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(k);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                        <button
                          class="btn btn--primary btn--sm"
                          disabled={props.busy()}
                          onClick={() => commitRename(k)}
                        >
                          Save
                        </button>
                        <button
                          class="btn btn--outline btn--sm"
                          disabled={props.busy()}
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </Show>
                    <Show when={expandedAccountId() === k.id && renamingId() !== k.id}>
                      <div
                        id={`anthropic-account-credential-${k.id}`}
                        class="anthropic-account__credential"
                      >
                        <div class="anthropic-account__credential-header">
                          <div>
                            <div class="provider-detail__label">Authorization code</div>
                            <p class="anthropic-account__credential-hint">
                              Current access token for this account. Treat it like a password.
                            </p>
                          </div>
                          <Show when={authorizationCode()}>
                            <CopyButton text={authorizationCode()} />
                          </Show>
                        </div>
                        <Show
                          when={!credentialLoading()}
                          fallback={
                            <div
                              class="anthropic-account__credential-loading"
                              role="status"
                              aria-live="polite"
                            >
                              <span class="spinner" /> Revealing credential…
                            </div>
                          }
                        >
                          <Show
                            when={!credentialError()}
                            fallback={
                              <div class="provider-detail__error" role="alert">
                                {credentialError()}
                              </div>
                            }
                          >
                            <code class="anthropic-account__credential-value">
                              {authorizationCode()}
                            </code>
                          </Show>
                        </Show>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        {/* Legacy connected state when the caller did not hydrate account rows. */}
        <Show when={!hasAccountRows()}>
          <div class="provider-detail__field">
            <span class="provider-detail__no-key">
              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
            </span>
          </div>
        </Show>
      </Show>

      <Show when={showConnectForm()}>
        <div class="anthropic-detail__primary">
          <Show when={props.connected()}>
            <div class="anthropic-detail__alt-divider">
              <span>Add another connection</span>
            </div>
          </Show>
          <p class="provider-detail__hint">
            <Show
              when={props.connected()}
              fallback="Sign in with your Claude Pro or Max account. Manifest will route through your subscription with auto-refreshing tokens."
            >
              Sign in with a different Claude Pro or Max account to route across more than one
              subscription.
            </Show>
          </p>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy()}
            onClick={handleSignIn}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Sign in with Claude
            </Show>
          </button>
        </div>

        <div class="anthropic-detail__alt">
          <div class="anthropic-detail__alt-divider">
            <span>Paste the authorization code</span>
          </div>
          <p class="anthropic-detail__alt-hint">
            After signing in, Anthropic's redirect page shows a code. Copy the full string and paste
            it below.
          </p>
          <input
            class="provider-detail__input provider-detail__input--masked"
            classList={{ 'provider-detail__input--error': !!error() }}
            type="text"
            autocomplete="off"
            placeholder="Authorization code"
            aria-label="Anthropic authorization code"
            value={input()}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
          />
          <Show when={error()}>
            <div class="provider-detail__error">{error()}</div>
          </Show>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy() || !input().trim()}
            onClick={handleSubmit}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              <Show when={props.connected()} fallback="Connect">
                Add connection
              </Show>
            </Show>
          </button>
        </div>
      </Show>

      <Show when={props.connected()}>
        <button
          class="btn btn--outline provider-detail__action provider-detail__disconnect"
          disabled={props.busy()}
          onClick={handleDisconnect}
        >
          <Show when={!props.busy()} fallback={<span class="spinner" />}>
            <Show when={isMultiKey()} fallback="Disconnect">
              Disconnect all
            </Show>
          </Show>
        </button>
      </Show>
    </>
  );
};

export default AnthropicOAuthDetailView;
