import { Component, createResource, createSignal, For, Show } from 'solid-js';
import {
  getWorkspaces,
  getWorkspaceMembers,
  addWorkspaceMember,
  removeWorkspaceMember,
} from '../services/api/workspaces.js';

/**
 * Member management for the ACTIVE workspace: list everyone with access,
 * add a user by email (they must already have an account on this instance),
 * remove users. Only owners/admins can mutate — the backend enforces it,
 * the UI just hides the controls for plain members.
 */
const WorkspaceMembers: Component = () => {
  const [overview, { refetch: refetchOverview }] = createResource(getWorkspaces);
  const activeId = () => overview()?.activeTenantId ?? null;
  const canManage = () => {
    const role = overview()?.activeRole;
    return role === 'owner' || role === 'admin';
  };
  const [members, { refetch }] = createResource(activeId, (id) => getWorkspaceMembers(id));

  const [email, setEmail] = createSignal('');
  const [role, setRole] = createSignal<'member' | 'admin'>('member');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const activeName = () =>
    overview()?.workspaces.find((w) => w.id === activeId())?.name ?? 'Current workspace';

  const handleAdd = async (e: Event) => {
    e.preventDefault();
    const id = activeId();
    if (!id || !email().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addWorkspaceMember(id, email().trim(), role());
      setEmail('');
      await refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (userId: string) => {
    const id = activeId();
    if (!id) return;
    await removeWorkspaceMember(id, userId);
    await Promise.all([refetch(), refetchOverview()]);
  };

  return (
    <div style="max-width: 720px; margin: 0 auto; padding: 24px;">
      <h1 style="margin-bottom: 4px;">Workspace members</h1>
      <p style="opacity: 0.7; margin-top: 0;">{activeName()}</p>

      <Show when={canManage()}>
        <form
          onSubmit={(e) => void handleAdd(e)}
          style="display: flex; gap: 8px; margin: 16px 0; align-items: center;"
        >
          <input
            type="email"
            placeholder="user@example.com"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
            style="flex: 1; padding: 8px 10px;"
            required
          />
          <select
            value={role()}
            onChange={(e) => setRole(e.currentTarget.value as 'member' | 'admin')}
            style="padding: 8px;"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" disabled={busy()} style="padding: 8px 16px;">
            Add
          </button>
        </form>
        <p style="font-size: 12px; opacity: 0.6; margin-top: -8px;">
          The person must already have an account on this instance — ask them to sign up first.
        </p>
        <Show when={error()}>
          <p style="color: var(--color-danger, #d33); font-size: 13px;">{error()}</p>
        </Show>
      </Show>

      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <thead>
          <tr style="text-align: left; opacity: 0.6; font-size: 12px;">
            <th style="padding: 8px 4px;">Name</th>
            <th style="padding: 8px 4px;">Email</th>
            <th style="padding: 8px 4px;">Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <For each={members()?.members ?? []}>
            {(m) => (
              <tr style="border-top: 1px solid rgba(128,128,128,0.2);">
                <td style="padding: 10px 4px;">{m.name ?? '—'}</td>
                <td style="padding: 10px 4px;">{m.email ?? m.userId}</td>
                <td style="padding: 10px 4px; text-transform: capitalize;">{m.role}</td>
                <td style="padding: 10px 4px; text-align: right;">
                  <Show when={canManage() && m.role !== 'owner'}>
                    <button onClick={() => void handleRemove(m.userId)} style="padding: 4px 10px;">
                      Remove
                    </button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
};

export default WorkspaceMembers;
