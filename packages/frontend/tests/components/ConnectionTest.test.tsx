import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

vi.mock('../../src/services/api.js', () => ({
  testProviderConnection: vi.fn(),
}));

import { ConnectionTestButton, ConnectionTestResultLine } from '../../src/components/ConnectionTest';
import { testProviderConnection, type ConnectionTestResult } from '../../src/services/api.js';

const mockTest = testProviderConnection as unknown as ReturnType<typeof vi.fn>;

const result = (over: Partial<ConnectionTestResult> = {}): ConnectionTestResult => ({
  connection_id: 'tp-1',
  provider: 'gemini',
  label: 'vc pro',
  status: 'ok',
  model: 'gemini-2.5-flash',
  latency_ms: 412,
  http_status: 200,
  message: 'Replied in 412ms.',
  tested_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

// These drive the real store, so every case uses its own connection id.
beforeEach(() => mockTest.mockClear());

describe('ConnectionTestButton', () => {
  it('labels itself with the account name so screen readers can tell cards apart', () => {
    render(() => <ConnectionTestButton connectionId="tp-label" label="vc pro 3" />);

    const button = screen.getByRole('button', {
      name: 'Test account vc pro 3',
    }) as HTMLButtonElement;
    expect(button.textContent).toBe('Test');
    expect(button.disabled).toBe(false);
  });

  it('is disabled while the parent view is busy', () => {
    render(() => <ConnectionTestButton connectionId="tp-busy" label="vc pro" busy />);

    const button = screen.getByRole('button', {
      name: 'Test account vc pro',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('swaps to a spinner and locks out re-entry while the test runs', async () => {
    let release: (value: ConnectionTestResult) => void = () => {};
    mockTest.mockReturnValueOnce(
      new Promise<ConnectionTestResult>((resolve) => {
        release = resolve;
      }),
    );
    const { container } = render(() => (
      <ConnectionTestButton connectionId="tp-spin" label="vc pro 2" />
    ));

    const button = screen.getByRole('button', {
      name: 'Test account vc pro 2',
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(container.querySelector('.spinner')).not.toBeNull());
    expect(button.disabled).toBe(true);
    expect(mockTest).toHaveBeenCalledWith('tp-spin');

    release(result({ connection_id: 'tp-spin' }));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(container.querySelector('.spinner')).toBeNull();
  });
});

describe('ConnectionTestResultLine', () => {
  it('renders nothing until a test has run', () => {
    const { container } = render(() => <ConnectionTestResultLine connectionId="tp-empty" />);

    expect(container.querySelector('.connection-test__result')).toBeNull();
  });

  it.each([
    ['ok', 'connection-test__result--ok', 'Working'],
    ['failed', 'connection-test__result--failed', 'Failed'],
    ['needs_reconnect', 'connection-test__result--failed', 'Reconnect needed'],
    ['untestable', 'connection-test__result--muted', 'Not testable'],
  ] as const)('renders a %s result with its own tone and prefix', async (status, tone, prefix) => {
    const connectionId = `tp-${status}`;
    mockTest.mockResolvedValueOnce(
      result({ connection_id: connectionId, status, message: 'the provider said so' }),
    );
    render(() => (
      <>
        <ConnectionTestButton connectionId={connectionId} label="vc pro" />
        <ConnectionTestResultLine connectionId={connectionId} />
      </>
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Test account vc pro' }));

    const line = await screen.findByRole('status');
    expect(line.getAttribute('data-status')).toBe(status);
    expect(line.className).toContain(tone);
    expect(line.textContent).toBe(`${prefix} — the provider said so`);
  });
});
