import {
  Component,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  createEffect,
} from 'solid-js';
import { A } from '@solidjs/router';
import { getWorkspaces, createWorkspace, switchWorkspace } from '../services/api/workspaces.js';

/**
 * Header dropdown for choosing the active workspace. Switching sets the
 * manifest_active_tenant cookie server-side, then hard-reloads so every
 * resource (SWR cache, SSE stream) rebinds to the new tenant.
 */
const WorkspaceSwitcher: Component = () => {
  const [data, { refetch }] = createResource(getWorkspaces);
  const [open, setOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal('');

  const active = () => {
    const d = data();
    if (!d) return null;
    return d.workspaces.find((w) => w.id === d.activeTenantId) ?? d.workspaces[0] ?? null;
  };

  const handleSwitch = async (id: string) => {
    if (id === data()?.activeTenantId) {
      setOpen(false);
      return;
    }
    await switchWorkspace(id);
    window.location.reload();
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = newName().trim();
    if (!name) return;
    const ws = await createWorkspace(name);
    setNewName('');
    setCreating(false);
    await refetch();
    await handleSwitch(ws.id);
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.workspace-switcher')) setOpen(false);
  };
  createEffect(() => {
    if (open()) {
      document.addEventListener('click', handleClickOutside);
      onCleanup(() => document.removeEventListener('click', handleClickOutside));
    }
  });

  return (
    <Show when={data()}>
      <div class="workspace-switcher" style="position: relative; margin-right: 12px;">
        <button
          class="header__gear-btn"
          style="display: flex; align-items: center; gap: 6px; max-width: 220px; min-width: 0;"
          onClick={() => setOpen(!open())}
          aria-haspopup="menu"
          aria-expanded={open()}
          title="Switch workspace"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 40px;">
            {active()?.name ?? 'Workspace'}
          </span>
        </button>
        <Show when={open()}>
          <div class="header__dropdown" role="menu" style="left: auto; right: 0; min-width: 240px; max-width: 300px;">
            <div class="header__dropdown-header">
              <span class="header__dropdown-name">Workspaces</span>
            </div>
            <div class="header__dropdown-divider" />
            <For each={data()?.workspaces ?? []}>
              {(ws) => (
                <button
                  class="header__dropdown-item"
                  role="menuitem"
                  style={`display: flex; align-items: center; gap: 8px; white-space: nowrap;${ws.id === data()?.activeTenantId ? ' font-weight: 600;' : ''}`}
                  onClick={() => void handleSwitch(ws.id)}
                >
                  <span style="overflow: hidden; text-overflow: ellipsis;">{ws.name}</span>
                  <span style="margin-left: auto; opacity: 0.6; font-size: 11px; flex-shrink: 0;">
                    {ws.id === data()?.activeTenantId ? '✓ ' : ''}
                    {ws.role}
                  </span>
                </button>
              )}
            </For>
            <div class="header__dropdown-divider" />
            <Show
              when={creating()}
              fallback={
                <button
                  class="header__dropdown-item"
                  role="menuitem"
                  onClick={() => setCreating(true)}
                >
                  + New workspace
                </button>
              }
            >
              <form onSubmit={(e) => void handleCreate(e)} style="padding: 6px 12px;">
                <input
                  type="text"
                  placeholder="Workspace name"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  style="width: 100%; box-sizing: border-box; padding: 6px 8px; background: transparent; color: inherit; border: 1px solid rgba(128,128,128,0.4); border-radius: 6px; outline: none; font: inherit;"
                  autofocus
                />
              </form>
            </Show>
            <A
              href="/workspaces"
              class="header__dropdown-item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              Manage members
            </A>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default WorkspaceSwitcher;
