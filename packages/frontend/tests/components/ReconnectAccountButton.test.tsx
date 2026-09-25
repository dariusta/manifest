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
  it('is hidden until a connection test says the account must sign in again', () => {
    render(() => (
      <ReconnectAccountButton connectionId="ok" label="Work" onReconnect={vi.fn()} />
    ));
    expect(screen.queryByRole('button', { name: 'Reconnect account Work' })).toBeNull();
  });

  it('is hidden when this connection has never been tested', () => {
    render(() => (
      <ReconnectAccountButton connectionId="never" label="Work" onReconnect={vi.fn()} />
    ));
    expect(screen.queryByText('Reconnect')).toBeNull();
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
