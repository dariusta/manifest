import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class} onClick={props.onClick}>
      {props.children}
    </a>
  ),
}));

const mockGetWorkspaces = vi.fn();
vi.mock('../../src/services/api/workspaces.js', () => ({
  getWorkspaces: (...args: unknown[]) => mockGetWorkspaces(...args),
  createWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
}));

import WorkspaceSwitcher from '../../src/components/WorkspaceSwitcher';

/** Render, wait for the resource, then open the dropdown. */
async function openSwitcher() {
  const { container } = render(() => <WorkspaceSwitcher />);
  await waitFor(() => expect(container.querySelector('.header__gear-btn')).not.toBeNull());
  fireEvent.click(container.querySelector('.header__gear-btn')!);
  await waitFor(() => expect(container.querySelector('.header__dropdown')).not.toBeNull());
  return container;
}

const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.header__dropdown-item')).filter(
    (el) => el.tagName === 'BUTTON' && !el.textContent?.startsWith('+'),
  );

describe('WorkspaceSwitcher', () => {
  beforeEach(() => {
    mockGetWorkspaces.mockReset();
  });

  it('shows each workspace with its role and no superadmin affordances', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: [
        { id: 'a', name: 'Personal', role: 'owner' },
        { id: 'b', name: 'Mimic', role: 'admin' },
      ],
      activeTenantId: 'a',
      activeRole: 'owner',
      isSuperadmin: false,
    });

    const container = await openSwitcher();
    expect(rows(container).map((r) => r.textContent)).toEqual(['Personal✓ owner', 'Mimicadmin']);
    // No badge and no filter for an ordinary user with a short list.
    expect(container.textContent).not.toContain('superadmin');
    expect(container.querySelector('input[placeholder="Filter workspaces"]')).toBeNull();
  });

  it('badges the header and the borrowed rows for a superadmin', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: [
        { id: 'a', name: 'Personal', role: 'owner' },
        { id: 'z', name: 'Personal · ada@example.com', role: 'owner', viaSuperadmin: true },
      ],
      activeTenantId: 'a',
      activeRole: 'owner',
      isSuperadmin: true,
    });

    const container = await openSwitcher();
    // Header badge.
    expect(container.querySelector('.header__dropdown-header')!.textContent).toContain(
      'superadmin',
    );
    const borrowed = rows(container)[1]!;
    // The row is labelled by how it is visible, not by a role the user has.
    expect(borrowed.textContent).toContain('superadmin');
    expect(borrowed.getAttribute('title')).toBe('Visible because you are a superadmin');
    // The caller's own workspace keeps its real role and carries no explanation.
    expect(rows(container)[0]!.getAttribute('title')).toBeNull();
  });

  it('offers a filter once the list is long, and narrows it', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: Array.from({ length: 9 }, (_, i) => ({
        id: `w${i}`,
        name: i === 0 ? 'Mimic' : `Team ${i}`,
        role: 'owner' as const,
        viaSuperadmin: i > 0,
      })),
      activeTenantId: 'w0',
      activeRole: 'owner',
      isSuperadmin: true,
    });

    const container = await openSwitcher();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Filter workspaces"]');
    expect(input).not.toBeNull();
    expect(rows(container).length).toBe(9);

    fireEvent.input(input!, { target: { value: 'mimic' } });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(rows(container)[0]!.textContent).toContain('Mimic');
  });

  it('clears the filter on close so reopening never shows a silently narrowed list', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: Array.from({ length: 9 }, (_, i) => ({
        id: `w${i}`,
        name: `Team ${i}`,
        role: 'owner' as const,
      })),
      activeTenantId: 'w0',
      activeRole: 'owner',
      isSuperadmin: true,
    });

    const container = await openSwitcher();
    fireEvent.input(container.querySelector('input[placeholder="Filter workspaces"]')!, {
      target: { value: 'Team 3' },
    });
    await waitFor(() => expect(rows(container).length).toBe(1));

    // Dismiss, then reopen.
    fireEvent.click(container.querySelector('.header__gear-btn')!);
    await waitFor(() => expect(container.querySelector('.header__dropdown')).toBeNull());
    fireEvent.click(container.querySelector('.header__gear-btn')!);
    await waitFor(() => expect(container.querySelector('.header__dropdown')).not.toBeNull());

    expect(container.querySelector<HTMLInputElement>('input[placeholder="Filter workspaces"]')!.value).toBe('');
    expect(rows(container).length).toBe(9);
  });

  it('gives the filter an accessible name, not just a placeholder', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: Array.from({ length: 9 }, (_, i) => ({
        id: `w${i}`,
        name: `Team ${i}`,
        role: 'owner' as const,
      })),
      activeTenantId: 'w0',
      activeRole: 'owner',
      isSuperadmin: true,
    });

    const container = await openSwitcher();
    expect(
      container.querySelector('input[placeholder="Filter workspaces"]')!.getAttribute('aria-label'),
    ).toBe('Filter workspaces');
  });

  it('explains an empty result instead of showing a blank list', async () => {
    mockGetWorkspaces.mockResolvedValue({
      workspaces: Array.from({ length: 9 }, (_, i) => ({
        id: `w${i}`,
        name: `Team ${i}`,
        role: 'owner' as const,
      })),
      activeTenantId: 'w0',
      activeRole: 'owner',
      isSuperadmin: true,
    });

    const container = await openSwitcher();
    fireEvent.input(container.querySelector('input[placeholder="Filter workspaces"]')!, {
      target: { value: 'nothing-matches' },
    });
    await waitFor(() => expect(container.textContent).toContain('No workspaces match.'));
  });
});
