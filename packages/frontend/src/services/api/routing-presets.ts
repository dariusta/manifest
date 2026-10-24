import type { RoutingPreset, RoutingPresetConfig } from 'manifest-shared';
import { fetchJson, fetchMutate } from './core.js';
export type { RoutingPreset, RoutingPresetConfig };
const path = (id: string) => `/routing-presets/${encodeURIComponent(id)}`;
export const getRoutingPresets = () => fetchJson<RoutingPreset[]>('/routing-presets');
export const createRoutingPreset = (name: string, sourceAgentName: string) =>
  fetchMutate<RoutingPreset>('/routing-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, sourceAgentName }),
  });
export const updateRoutingPreset = (id: string, name: string, config: RoutingPresetConfig) =>
  fetchMutate<RoutingPreset>(path(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  });
export const deleteRoutingPreset = (id: string) => fetchMutate(path(id), { method: 'DELETE' });
export const applyRoutingPreset = (id: string, agentName: string) =>
  fetchMutate(`${path(id)}/apply/${encodeURIComponent(agentName)}`, { method: 'POST' });
