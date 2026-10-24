import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import type { RoutingPreset } from 'manifest-shared';
import type { AvailableModel } from '../../src/services/api/routing';

const api = vi.hoisted(() => ({
  getRoutingPresets: vi.fn(),
  createRoutingPreset: vi.fn(),
  updateRoutingPreset: vi.fn(),
  applyRoutingPreset: vi.fn(),
  deleteRoutingPreset: vi.fn(),
}));
vi.mock('../../src/services/api/routing-presets.js', () => api);
vi.mock('../../src/services/toast-store.js', () => ({ toast: { success: vi.fn() } }));
import RoutingPresets from '../../src/components/RoutingPresets';

const route = (model: string) => ({ model, provider: 'openai', authType: 'api_key' as const });
let preset: RoutingPreset;
const models = ['a', 'b', 'c'].map((model) => ({
  model_name: model,
  provider: 'openai',
  auth_type: 'api_key',
})) as AvailableModel[];
const openEditor = async () => {
  await waitFor(() => expect(screen.getByRole('option', { name: 'Coding' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'preset-a' } });
  fireEvent.click(screen.getByText('Edit preset'));
};
beforeEach(() => {
  vi.clearAllMocks();
  preset = {
    id: 'preset-a',
    name: 'Coding',
    created_at: '',
    updated_at: '',
    config: {
      version: 1,
      providerIds: ['account-a'],
      complexityRoutingEnabled: false,
      tiers: [
        {
          tier: 'default',
          route: route('a'),
          fallbacks: [route('b'), route('c')],
          responseMode: 'buffered',
          outputModality: 'text',
        },
      ],
      specificity: [],
      headers: [],
      modelParams: [],
    },
  };
  api.getRoutingPresets.mockResolvedValue([preset]);
  api.createRoutingPreset.mockResolvedValue(preset);
  api.updateRoutingPreset.mockResolvedValue(preset);
  api.applyRoutingPreset.mockResolvedValue({ ok: true });
  api.deleteRoutingPreset.mockResolvedValue({ ok: true });
});

it('saves the current harness and applies a selected preset as a copy', async () => {
  const onApplied = vi.fn(async () => undefined);
  render(() => <RoutingPresets agentName="work" models={models} onApplied={onApplied} />);
  fireEvent.click(screen.getByText('Save current as preset'));
  fireEvent.input(screen.getByLabelText('Preset name'), { target: { value: 'Coding' } });
  fireEvent.click(screen.getByText('Save preset'));
  await waitFor(() => expect(api.createRoutingPreset).toHaveBeenCalledWith('Coding', 'work'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByText('Apply copy'));
  await waitFor(() => expect(api.applyRoutingPreset).toHaveBeenCalledWith('preset-a', 'work'));
  expect(onApplied).toHaveBeenCalledTimes(1);
});

it('edits fallback order and response mode without applying or mutating the original', async () => {
  render(() => (
    <RoutingPresets agentName="work" models={models} onApplied={async () => undefined} />
  ));
  await openEditor();
  fireEvent.click(screen.getByLabelText('Move fallback 2 up'));
  fireEvent.change(screen.getByLabelText('Default response mode'), { target: { value: 'stream' } });
  fireEvent.input(screen.getByLabelText('Preset name'), { target: { value: 'Updated' } });
  fireEvent.click(screen.getByText('Save preset'));
  await waitFor(() => expect(api.updateRoutingPreset).toHaveBeenCalled());
  const saved = api.updateRoutingPreset.mock.calls[0]!;
  expect(saved[0]).toBe('preset-a');
  expect(saved[1]).toBe('Updated');
  expect(saved[2].tiers[0]).toMatchObject({
    route: route('a'),
    fallbacks: [route('c'), route('b')],
    responseMode: 'stream',
  });
  expect(preset.config.tiers[0]!.fallbacks).toEqual([route('b'), route('c')]);
  expect(api.applyRoutingPreset).not.toHaveBeenCalled();
});

it('keeps a failed edit open with its error so it can be corrected', async () => {
  api.updateRoutingPreset.mockRejectedValue(new Error('Duplicate model routes in preset'));
  render(() => (
    <RoutingPresets agentName="work" models={models} onApplied={async () => undefined} />
  ));
  await openEditor();
  fireEvent.click(screen.getByText('Save preset'));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Duplicate model routes'),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('deletes only the preset and clears its selection', async () => {
  render(() => (
    <RoutingPresets agentName="work" models={models} onApplied={async () => undefined} />
  ));
  await openEditor();
  api.getRoutingPresets.mockResolvedValue([]);
  fireEvent.click(screen.getByText('Delete preset'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.deleteRoutingPreset).toHaveBeenCalledWith('preset-a');
  expect((screen.getByLabelText('Preset') as HTMLSelectElement).value).toBe('');
  expect(api.applyRoutingPreset).not.toHaveBeenCalled();
});
