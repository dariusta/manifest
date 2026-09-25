import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSignal } from 'solid-js';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('../../src/services/api.js', () => {
  const startMinimaxOAuth = vi.fn();
  const pollMinimaxOAuth = vi.fn();
  const revokeMinimaxOAuth = vi.fn();
  const startKiroOAuth = vi.fn();
  const pollKiroOAuth = vi.fn();
  const revokeKiroOAuth = vi.fn();
  const deviceApis: Record<string, unknown> = {
    minimax: {
      start: startMinimaxOAuth,
      poll: pollMinimaxOAuth,
      revoke: revokeMinimaxOAuth,
      hasRegion: true,
    },
    kiro: {
      start: startKiroOAuth,
      poll: pollKiroOAuth,
      revoke: revokeKiroOAuth,
      hasRegion: false,
    },
  };
  return {
    connectProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    renameProviderKey: vi.fn(),
    startMinimaxOAuth,
    pollMinimaxOAuth,
    revokeMinimaxOAuth,
    startKiroOAuth,
    pollKiroOAuth,
    revokeKiroOAuth,
    getDeviceCodeApi: (id: string) => deviceApis[id],
  };
});

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockClearConnectionTest = vi.fn();
vi.mock('../../src/services/connection-test-store.js', () => ({
  connectionTestResult: (id: string) =>
    id === 'k1' ? { status: 'needs_reconnect', message: 'Sign in again' } : undefined,
  clearConnectionTestResult: (...args: unknown[]) => mockClearConnectionTest(args[0]),
  isConnectionTestRunning: () => false,
  runConnectionTest: () => Promise.resolve(),
}));

import DeviceCodeDetailView from '../../src/components/DeviceCodeDetailView';
import {
  connectProvider,
  disconnectProvider,
  renameProviderKey,
  revokeMinimaxOAuth,
} from '../../src/services/api.js';
import { toast } from '../../src/services/toast-store.js';
import { getProvider } from '../../src/services/provider-utils';
import type { AuthType, RoutingProvider } from '../../src/services/api.js';

const mockConnectProvider = connectProvider as ReturnType<typeof vi.fn>;
const mockToast = toast as {
  error: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
};

function renderMinimax() {
  const provDef = getProvider('minimax')!;
  const [busy, setBusy] = createSignal(false);
  const [authType] = createSignal<AuthType>('subscription');
  const props = {
    provDef,
    provId: 'minimax',
    agentName: 'test-agent',
    connected: () => false,
    selectedAuthType: authType,
    busy,
    setBusy,
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onClose: vi.fn(),
  };
  const result = render(() => <DeviceCodeDetailView {...props} />);
  return { ...result, props };
}

describe('DeviceCodeDetailView — MiniMax Coding Plan token alternative', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the alternative token paste box for MiniMax', () => {
    renderMinimax();
    expect(screen.getByLabelText('MiniMax Coding Plan token')).toBeDefined();
    expect(screen.getByText('Connect with token')).toBeDefined();
  });

  it("rejects a token that doesn't start with sk-cp-", async () => {
    renderMinimax();
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'sk-wrong-token-long-enough' } });
    await fireEvent.click(screen.getByText('Connect with token'));
    await waitFor(() => {
      expect(screen.getByText('MiniMax subscription tokens start with "sk-cp-"')).toBeDefined();
    });
    expect(mockConnectProvider).not.toHaveBeenCalled();
  });

  it('connects with a valid sk-cp- token, defaulting to global region', async () => {
    mockConnectProvider.mockResolvedValueOnce(undefined);
    const { props } = renderMinimax();
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    const validToken = 'sk-cp-' + 'a'.repeat(40);
    await fireEvent.input(input, { target: { value: validToken } });
    await fireEvent.click(screen.getByText('Connect with token'));
    await waitFor(() => {
      expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
        provider: 'minimax',
        apiKey: validToken,
        authType: 'subscription',
        region: 'global',
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith('MiniMax subscription connected');
    expect(props.onUpdate).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('forwards the selected CN region with the pasted token', async () => {
    mockConnectProvider.mockResolvedValueOnce(undefined);
    renderMinimax();
    const regionSelect = screen.getByLabelText('Region') as HTMLSelectElement;
    await fireEvent.change(regionSelect, { target: { value: 'cn' } });
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    const validToken = 'sk-cp-' + 'd'.repeat(40);
    await fireEvent.input(input, { target: { value: validToken } });
    await fireEvent.click(screen.getByText('Connect with token'));
    await waitFor(() => {
      expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
        provider: 'minimax',
        apiKey: validToken,
        authType: 'subscription',
        region: 'cn',
      });
    });
  });

  it('submits the token on Enter key', async () => {
    mockConnectProvider.mockResolvedValueOnce(undefined);
    renderMinimax();
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    const validToken = 'sk-cp-' + 'b'.repeat(40);
    await fireEvent.input(input, { target: { value: validToken } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mockConnectProvider).toHaveBeenCalled();
    });
  });

  it('disables Connect when input is empty', () => {
    renderMinimax();
    const button = screen.getByText('Connect with token').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('does not close on connect failure and resets busy', async () => {
    mockConnectProvider.mockRejectedValueOnce(new Error('boom'));
    const { props } = renderMinimax();
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    const validToken = 'sk-cp-' + 'c'.repeat(40);
    await fireEvent.input(input, { target: { value: validToken } });
    await fireEvent.click(screen.getByText('Connect with token'));
    await waitFor(() => {
      expect(mockConnectProvider).toHaveBeenCalled();
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('clears validation error when user edits the input', async () => {
    renderMinimax();
    const input = screen.getByLabelText('MiniMax Coding Plan token') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'bad-prefix-long-enough' } });
    await fireEvent.click(screen.getByText('Connect with token'));
    await waitFor(() => {
      expect(screen.getByText('MiniMax subscription tokens start with "sk-cp-"')).toBeDefined();
    });
    await fireEvent.input(input, { target: { value: 'sk-cp-fresh' } });
    expect(screen.queryByText('MiniMax subscription tokens start with "sk-cp-"')).toBeNull();
  });
});

const mockDisconnectProvider = disconnectProvider as ReturnType<typeof vi.fn>;
const mockRevokeMinimaxOAuth = revokeMinimaxOAuth as ReturnType<typeof vi.fn>;
const mockRenameProviderKey = renameProviderKey as ReturnType<typeof vi.fn>;

function makeKey(overrides: Partial<RoutingProvider> = {}): RoutingProvider {
  return {
    id: 'key-1',
    provider: 'minimax',
    auth_type: 'subscription',
    is_active: true,
    has_api_key: true,
    key_prefix: null,
    label: 'Account 1',
    priority: 1,
    region: null,
    connected_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderMultiKeyMinimax(keys: RoutingProvider[]) {
  const provDef = getProvider('minimax')!;
  const [busy, setBusy] = createSignal(false);
  const [authType] = createSignal<AuthType>('subscription');
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const result = render(() => (
    <DeviceCodeDetailView
      provDef={provDef}
      provId="minimax"
      agentName="test-agent"
      connected={() => true}
      selectedAuthType={authType}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
      activeKeys={() => keys}
    />
  ));
  return { ...result, onBack, onUpdate, onClose };
}

describe('DeviceCodeDetailView — multi-key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders multi-key list when activeKeys has 2+ items', () => {
    const keys = [makeKey({ id: 'k1', label: 'Work' }), makeKey({ id: 'k2', label: 'Personal' })];
    renderMultiKeyMinimax(keys);
    expect(screen.getByText('Accounts')).toBeDefined();
    expect(screen.getByText('Work')).toBeDefined();
    expect(screen.getByText('Personal')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reconnect account Work' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reconnect account Personal' })).toBeNull();
  });

  it('reconnects the named MiniMax account in its stored region', async () => {
    vi.useFakeTimers();
    try {
      const api = await import('../../src/services/api.js');
      const startMinimaxOAuth = api.startMinimaxOAuth as ReturnType<typeof vi.fn>;
      const pollMinimaxOAuth = api.pollMinimaxOAuth as ReturnType<typeof vi.fn>;
      const { toast } = await import('../../src/services/toast-store.js');
      startMinimaxOAuth.mockResolvedValue({
        flowId: 'f-reconnect',
        userCode: 'ABCD-1234',
        verificationUri: 'https://minimax.io/verify',
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 1000,
      });
      pollMinimaxOAuth.mockResolvedValue({ status: 'success' });
      const openSpy = vi.spyOn(window, 'open').mockReturnValue({
        closed: false,
        opener: null,
        location: { replace: vi.fn() },
        close: vi.fn(),
      } as unknown as Window);
      const keys = [
        makeKey({ id: 'k1', label: 'Work', region: 'cn' }),
        makeKey({ id: 'k2', label: 'Personal' }),
      ];
      const { onUpdate } = renderMultiKeyMinimax(keys);

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect account Work' }));

      await vi.waitFor(() => {
        expect(startMinimaxOAuth).toHaveBeenCalledWith('test-agent', {
          label: 'Work',
          region: 'cn',
        });
      });
      expect(screen.getByText('Accounts')).toBeDefined();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('MiniMax account reconnected');
      });
      expect(mockClearConnectionTest).toHaveBeenCalledWith('k1');
      expect(onUpdate).toHaveBeenCalled();
      openSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the account list when a reconnect popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const keys = [
      makeKey({ id: 'k1', label: 'Work', region: null }),
      makeKey({ id: 'k2', label: 'Personal' }),
    ];
    renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account Work' }));

    const { toast } = await import('../../src/services/toast-store.js');
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Popup was blocked/));
    });
    expect(screen.getByText('Accounts')).toBeDefined();
  });

  it('closes a reconnect popup that resolves after the view unmounts', async () => {
    let resolveStart: (value: unknown) => void = () => {};
    const api = await import('../../src/services/api.js');
    const startMinimaxOAuth = api.startMinimaxOAuth as ReturnType<typeof vi.fn>;
    startMinimaxOAuth.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      close,
      location: { replace: vi.fn() },
    } as unknown as Window);
    const keys = [makeKey({ id: 'k1', label: 'Work' }), makeKey({ id: 'k2', label: 'Personal' })];
    const view = renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account Work' }));
    await waitFor(() => expect(startMinimaxOAuth).toHaveBeenCalled());
    view.unmount();
    resolveStart({
      flowId: 'late',
      userCode: 'C',
      verificationUri: 'https://minimax.io/verify',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 1000,
    });
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('closes the popup and keeps the account list when a reconnect start fails', async () => {
    const api = await import('../../src/services/api.js');
    const startMinimaxOAuth = api.startMinimaxOAuth as ReturnType<typeof vi.fn>;
    startMinimaxOAuth.mockRejectedValue(new Error('network'));
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      close,
      location: { replace: vi.fn() },
    } as unknown as Window);
    const keys = [makeKey({ id: 'k1', label: 'Work' }), makeKey({ id: 'k2', label: 'Personal' })];
    renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account Work' }));

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(screen.getByText('Accounts')).toBeDefined();
    expect(screen.queryByText(/authorization page/)).toBeNull();
  });

  it('rename flow: clicking Rename shows input and saving calls renameProviderKey', async () => {
    mockRenameProviderKey.mockResolvedValue({ id: 'k1', label: 'New', priority: 1 });
    const keys = [makeKey({ id: 'k1', label: 'Old' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderMultiKeyMinimax(keys);

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old');
    fireEvent.input(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalledWith(
        'test-agent',
        'minimax',
        'Old',
        'New',
        'subscription',
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith('Renamed to "New"');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('delete individual key calls revokeMinimaxOAuth with label', async () => {
    mockRevokeMinimaxOAuth.mockResolvedValue({ ok: true, notifications: [] });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeMinimaxOAuth).toHaveBeenCalledWith('test-agent', 'Primary');
    });
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('single-key disconnect calls revoke and navigates back', async () => {
    mockRevokeMinimaxOAuth.mockResolvedValue({ ok: true, notifications: [] });
    const { onBack, onUpdate } = renderMultiKeyMinimax([makeKey({ id: 'only', label: 'Solo' })]);

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockRevokeMinimaxOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(onBack).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('single-key disconnect failure resets busy without navigating back', async () => {
    mockRevokeMinimaxOAuth.mockRejectedValue(new Error('network'));
    const { onBack } = renderMultiKeyMinimax([makeKey({ id: 'only', label: 'Solo' })]);

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockRevokeMinimaxOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('rename is a no-op when the label is unchanged', async () => {
    const keys = [makeKey({ id: 'k1', label: 'Same' }), makeKey({ id: 'k2', label: 'Other' })];
    renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getAllByText('Rename')[0]);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Rename Same')).toBeNull();
    });
    expect(mockRenameProviderKey).not.toHaveBeenCalled();
  });

  it('shows Disconnect all button in multi-key mode', () => {
    const keys = [makeKey({ id: 'k1', label: 'A' }), makeKey({ id: 'k2', label: 'B' })];
    renderMultiKeyMinimax(keys);
    expect(screen.getByText('Disconnect all')).toBeDefined();
  });

  it('handleDeleteKey surfaces notifications from revokeMinimaxOAuth', async () => {
    mockRevokeMinimaxOAuth.mockResolvedValue({
      ok: true,
      notifications: ['Key still shared with another agent'],
    });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Key still shared with another agent');
    });
  });

  it('handleDeleteKey catch branch when revokeMinimaxOAuth fails', async () => {
    mockRevokeMinimaxOAuth.mockRejectedValue(new Error('network'));
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderMultiKeyMinimax(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeMinimaxOAuth).toHaveBeenCalledWith('test-agent', 'Primary');
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('commitRename catch branch when renameProviderKey fails', async () => {
    mockRenameProviderKey.mockRejectedValue(new Error('network'));
    const keys = [makeKey({ id: 'k1', label: 'Old' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderMultiKeyMinimax(keys);

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old');
    fireEvent.input(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalled();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

function renderConnectedWithAddKeyOpen() {
  const provDef = getProvider('minimax')!;
  const [busy, setBusy] = createSignal(false);
  const [authType] = createSignal<AuthType>('subscription');
  const [addKeyOpen, setAddKeyOpen] = createSignal(true);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const keys = [makeKey()];
  const result = render(() => (
    <DeviceCodeDetailView
      provDef={provDef}
      provId="minimax"
      agentName="test-agent"
      connected={() => true}
      selectedAuthType={authType}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
      addKeyOpen={addKeyOpen}
      setAddKeyOpen={setAddKeyOpen}
      activeKeys={() => keys}
    />
  ));
  return { ...result, onBack, onUpdate, onClose, setAddKeyOpen };
}

describe('DeviceCodeDetailView — addKeyOpen effect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-launches handleStart when addKeyOpen is true and connected', async () => {
    const startMinimaxOAuth = (await import('../../src/services/api.js'))
      .startMinimaxOAuth as ReturnType<typeof vi.fn>;
    startMinimaxOAuth.mockResolvedValue({
      flowId: 'f1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://minimax.io/verify',
      expiresAt: Date.now() + 60000,
      pollIntervalMs: 2000,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      location: { replace: vi.fn() },
    } as unknown as Window);

    renderConnectedWithAddKeyOpen();

    await waitFor(() => {
      expect(startMinimaxOAuth).toHaveBeenCalledWith('test-agent', { region: 'global' });
    });
    expect(screen.getByText(/A new tab opened with the MiniMax authorization page/)).toBeDefined();
    openSpy.mockRestore();
  });

  it('shows pending status while a connected MiniMax add-account flow is waiting', async () => {
    vi.useFakeTimers();
    try {
      const api = await import('../../src/services/api.js');
      const startMinimaxOAuth = api.startMinimaxOAuth as ReturnType<typeof vi.fn>;
      const pollMinimaxOAuth = api.pollMinimaxOAuth as ReturnType<typeof vi.fn>;
      startMinimaxOAuth.mockResolvedValue({
        flowId: 'f1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://minimax.io/verify',
        expiresAt: Date.now() + 60000,
        pollIntervalMs: 2000,
      });
      pollMinimaxOAuth.mockResolvedValue({
        status: 'pending',
        message: 'Still waiting for approval',
        pollIntervalMs: 2000,
      });
      const openSpy = vi.spyOn(window, 'open').mockReturnValue({
        closed: false,
        opener: null,
        location: { replace: vi.fn() },
      } as unknown as Window);

      renderConnectedWithAddKeyOpen();

      await waitFor(() => {
        expect(startMinimaxOAuth).toHaveBeenCalledWith('test-agent', { region: 'global' });
      });
      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        expect(screen.getByText('Still waiting for approval')).toBeDefined();
      });
      openSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels a pasted token when adding another connected MiniMax account', async () => {
    mockConnectProvider.mockResolvedValueOnce(undefined);
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderConnectedWithAddKeyOpen();

    const input = await waitFor(() => screen.getByLabelText('MiniMax Coding Plan token'));
    const validToken = 'sk-cp-' + 'e'.repeat(40);
    fireEvent.input(input, { target: { value: validToken } });
    fireEvent.click(screen.getByText('Connect with token'));

    await waitFor(() => {
      expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
        provider: 'minimax',
        apiKey: validToken,
        authType: 'subscription',
        region: 'global',
        label: 'Key 2',
      });
    });
  });

  it('cancels a connected add-account MiniMax device-code flow', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderConnectedWithAddKeyOpen();

    await waitFor(() => {
      expect(screen.getByLabelText('MiniMax Coding Plan token')).toBeDefined();
    });
    fireEvent.input(screen.getByLabelText('MiniMax Coding Plan token'), {
      target: { value: 'sk-cp-' + 'f'.repeat(40) },
    });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByLabelText('MiniMax Coding Plan token')).toBeNull();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });
});

function renderKiro() {
  const provDef = getProvider('kiro')!;
  const [busy, setBusy] = createSignal(false);
  const [authType] = createSignal<AuthType>('subscription');
  const props = {
    provDef,
    provId: 'kiro',
    agentName: 'test-agent',
    connected: () => false,
    selectedAuthType: authType,
    busy,
    setBusy,
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onClose: vi.fn(),
  };
  return { ...render(() => <DeviceCodeDetailView {...props} />), props };
}

async function selectKiroRegion(value: string) {
  await fireEvent.click(screen.getByLabelText('Region'));
  await fireEvent.click(screen.getByRole('option', { name: value }));
}

describe('DeviceCodeDetailView — Kiro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows all supported regions without an Other region option', async () => {
    renderKiro();
    expect(screen.getByLabelText('Region').textContent).toContain('us-east-1');
    await fireEvent.click(screen.getByLabelText('Region'));
    expect(screen.getByRole('option', { name: 'eu-west-1' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'ap-east-2' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'eu-central-2' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'mx-central-1' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'us-gov-west-1' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Other region...' })).toBeNull();
    expect((screen.getByLabelText(/Start URL/) as HTMLInputElement).value).toBe('');
    expect(
      screen.getByText(
        'Choose the AWS region for Kiro sign-in. Add a Start URL only if your organization uses IAM Identity Center.',
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText('Sign in with AWS IAM Identity Center')).toBeNull();
  });

  it('does not render the MiniMax token-paste alternative', () => {
    renderKiro();
    expect(screen.queryByText('Connect with token')).toBeNull();
  });

  it('starts the device flow with the default Kiro region', async () => {
    const api = await import('../../src/services/api.js');
    const startKiroOAuth = api.startKiroOAuth as ReturnType<typeof vi.fn>;
    startKiroOAuth.mockResolvedValue({
      flowId: 'f1',
      userCode: 'AAAA-BBBB',
      verificationUri: 'https://view.awsapps.com/start',
      expiresAt: Date.now() + 60000,
      pollIntervalMs: 5000,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      location: { replace: vi.fn() },
    } as unknown as Window);

    renderKiro();
    fireEvent.click(screen.getByText('Connect with Kiro'));

    await waitFor(() => {
      expect(startKiroOAuth).toHaveBeenCalledWith('test-agent', { region: 'us-east-1' });
    });
    openSpy.mockRestore();
  });

  it('passes optional IAM Identity Center start URL and selected region', async () => {
    const api = await import('../../src/services/api.js');
    const startKiroOAuth = api.startKiroOAuth as ReturnType<typeof vi.fn>;
    startKiroOAuth.mockResolvedValue({
      flowId: 'f1',
      userCode: 'AAAA-BBBB',
      verificationUri: 'https://device.sso.eu-west-1.amazonaws.com/?user_code=AAAA-BBBB',
      expiresAt: Date.now() + 60000,
      pollIntervalMs: 5000,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      location: { replace: vi.fn() },
    } as unknown as Window);

    renderKiro();
    fireEvent.input(screen.getByLabelText(/Start URL/), {
      target: { value: 'https://org.awsapps.com/start' },
    });
    await selectKiroRegion('eu-west-1');
    fireEvent.click(screen.getByText('Connect with Kiro'));

    await waitFor(() => {
      expect(startKiroOAuth).toHaveBeenCalledWith('test-agent', {
        startUrl: 'https://org.awsapps.com/start',
        region: 'eu-west-1',
      });
    });
    openSpy.mockRestore();
  });

  it('passes a selected opt-in AWS region', async () => {
    const api = await import('../../src/services/api.js');
    const startKiroOAuth = api.startKiroOAuth as ReturnType<typeof vi.fn>;
    startKiroOAuth.mockResolvedValue({
      flowId: 'f1',
      userCode: 'AAAA-BBBB',
      verificationUri: 'https://device.sso.ap-east-2.amazonaws.com/?user_code=AAAA-BBBB',
      expiresAt: Date.now() + 60000,
      pollIntervalMs: 5000,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      location: { replace: vi.fn() },
    } as unknown as Window);

    renderKiro();
    await selectKiroRegion('ap-east-2');
    fireEvent.click(screen.getByText('Connect with Kiro'));

    await waitFor(() => {
      expect(startKiroOAuth).toHaveBeenCalledWith('test-agent', { region: 'ap-east-2' });
    });
    openSpy.mockRestore();
  });

  it.each([
    ['Start URL must use HTTPS.', 'http://org.awsapps.com/start', 'us-east-1'],
    ['Enter a valid IAM Identity Center Start URL.', 'not-a-url', 'us-east-1'],
  ])('validates %s before opening the Kiro popup', async (message, startUrl, region) => {
    const api = await import('../../src/services/api.js');
    const startKiroOAuth = api.startKiroOAuth as ReturnType<typeof vi.fn>;
    const openSpy = vi.spyOn(window, 'open');

    renderKiro();
    fireEvent.input(screen.getByLabelText(/Start URL/), { target: { value: startUrl } });
    await selectKiroRegion(region);
    fireEvent.click(screen.getByText('Connect with Kiro'));

    expect(screen.getByText(message)).toBeDefined();
    expect(screen.getByLabelText('Region').getAttribute('aria-describedby')).toBe(
      'kiro-identity-error',
    );
    expect(screen.getByLabelText(/Start URL/).getAttribute('aria-describedby')).toBe(
      'kiro-identity-error',
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(startKiroOAuth).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
