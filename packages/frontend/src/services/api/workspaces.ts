import { fetchJson, fetchMutate } from './core.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface Workspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  /**
   * Present only for workspaces the caller sees because they are an instance
   * superadmin — they neither own nor belong to it.
   */
  viaSuperadmin?: boolean;
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
  activeTenantId: string | null;
  activeRole: WorkspaceRole;
  /** Optional: older backends omit it. */
  isSuperadmin?: boolean;
}

export interface WorkspaceMember {
  userId: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
}

export function getWorkspaces(): Promise<WorkspacesResponse> {
  return fetchJson<WorkspacesResponse>('/workspaces', undefined, { cache: false });
}

export function createWorkspace(name: string): Promise<Workspace> {
  return fetchMutate<Workspace>('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function switchWorkspace(id: string): Promise<{ activeTenantId: string }> {
  return fetchMutate<{ activeTenantId: string }>(`/workspaces/${encodeURIComponent(id)}/switch`, {
    method: 'POST',
  });
}

export function getWorkspaceMembers(id: string): Promise<{ members: WorkspaceMember[] }> {
  return fetchJson<{ members: WorkspaceMember[] }>(
    `/workspaces/${encodeURIComponent(id)}/members`,
    undefined,
    { cache: false },
  );
}

export function addWorkspaceMember(
  id: string,
  email: string,
  role: 'admin' | 'member',
): Promise<WorkspaceMember> {
  return fetchMutate<WorkspaceMember>(`/workspaces/${encodeURIComponent(id)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
}

export function removeWorkspaceMember(id: string, userId: string): Promise<void> {
  return fetchMutate<void>(
    `/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}
