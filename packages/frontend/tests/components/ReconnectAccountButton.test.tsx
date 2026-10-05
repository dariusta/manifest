import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ReconnectAccountButton } from '../../src/components/ReconnectAccountButton';

vi.mock('../../src/services/connection-test-store.js', () => ({
  connectionTestResult: (id: string) =>
    id === 'needs-it'
      ? { status: 'needs_reconnect' }
      : id === 'ok'
        ? { status: 'ok' }
        : undefined,
}));

describe('ReconnectAccountButton', () => {
  it('renders a Replace action even when the connection never needed a reconnect', () => {
    render(() => (
      <ReconnectAccountButton connectionId="ok" label="Work" always onReconnect={vi.fn()} />
    ));
    expect(screen.getByRole('button', { name: 'Replace account Work' })).not.toBeNull();
  });

  it('keeps the Reconnect caption after a test says the account must sign in again', () => {
    render(() => (
      <ReconnectAccountButton connectionId="needs-it" label="Work" always onReconnect={vi.fn()} />
    ));
    expect(screen.getByRole('button', { name: 'Reconnect account Work' })).not.toBeNull();
  });

  it('disables the button while the parent view is busy', () => {
    render(() => (
      <ReconnectAccountButton connectionId="needs-it" label="Work" busy onReconnect={vi.fn()} />
    ));
    expect((screen.getByRole('button', { name: 'Reconnect account Work' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts a reconnect for the named account', () => {
    const onReconnect = vi.fn();
    render(() => (
      <ReconnectAccountButton connectionId="needs-it" label="Work" onReconnect={onReconnect} />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account Work' }));
    expect(onReconnect).toHaveBeenCalledWith('Work');
  });
});
