import { createSignal, For, Show, type Component } from 'solid-js';
import { createCachedResource } from '../services/cached-resource.js';
import type { ModelRoute, PresetChain, RoutingPresetConfig } from 'manifest-shared';
import type { AvailableModel, RoutingProvider } from '../services/api/routing.js';
import {
  applyRoutingPreset,
  createRoutingPreset,
  deleteRoutingPreset,
  getRoutingPresets,
  updateRoutingPreset,
} from '../services/api/routing-presets.js';
import { toast } from '../services/toast-store.js';
import '../styles/routing-presets.css';

const identity = (route: ModelRoute | null) =>
  route
    ? JSON.stringify({ provider: route.provider, authType: route.authType, model: route.model })
    : '';

const ChainEditor: Component<{
  title: string;
  chain: PresetChain;
  models: AvailableModel[];
  onChange: (chain: PresetChain) => void;
}> = (props) => {
  const options = () =>
    props.models.map((m) => ({
      route: {
        provider: m.provider,
        authType: m.auth_type ?? 'api_key',
        model: m.model_name,
      } as ModelRoute,
      label: `${m.display_name || m.model_name} · ${m.provider}${m.auth_type === 'subscription' ? ' · subscription' : ''}`,
    }));
  const picker = (
    route: ModelRoute | null,
    label: string,
    change: (route: ModelRoute | null) => void,
  ) => (
    <select
      class="modal-card__input"
      aria-label={label}
      value={identity(route)}
      onChange={(e) => change(e.currentTarget.value ? JSON.parse(e.currentTarget.value) : null)}
    >
      <option value="">Choose a model</option>
      <Show when={route && !options().some((m) => identity(m.route) === identity(route))}>
        <option value={identity(route)}>{route?.model} · unavailable</option>
      </Show>
      <For each={options()}>
        {(option) => <option value={identity(option.route)}>{option.label}</option>}
      </For>
    </select>
  );
  const changeFallback = (index: number, route: ModelRoute | null) => {
    const fallbacks = [...props.chain.fallbacks];
    if (route) fallbacks[index] = route;
    else fallbacks.splice(index, 1);
    props.onChange({ ...props.chain, fallbacks });
  };
  const move = (index: number, delta: number) => {
    const fallbacks = [...props.chain.fallbacks];
    const first = fallbacks[index];
    const second = fallbacks[index + delta];
    if (!first || !second) return;
    [fallbacks[index], fallbacks[index + delta]] = [second, first];
    props.onChange({ ...props.chain, fallbacks });
  };
  const add = () => {
    const used = new Set([identity(props.chain.route), ...props.chain.fallbacks.map(identity)]);
    const next = options().find((m) => !used.has(identity(m.route)));
    if (next) props.onChange({ ...props.chain, fallbacks: [...props.chain.fallbacks, next.route] });
  };
  return (
    <fieldset class="preset-chain">
      <legend>{props.title}</legend>
      <label>
        Primary model
        {picker(props.chain.route, `${props.title} primary model`, (route) =>
          props.onChange({ ...props.chain, route }),
        )}
      </label>
      <For each={props.chain.fallbacks}>
        {(route, index) => (
          <div class="preset-chain__fallback">
            <span>{index() + 1}</span>
            {picker(route, `${props.title} fallback ${index() + 1}`, (value) =>
              changeFallback(index(), value),
            )}
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              aria-label={`Move fallback ${index() + 1} up`}
              disabled={index() === 0}
              onClick={() => move(index(), -1)}
            >
              ↑
            </button>
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              aria-label={`Move fallback ${index() + 1} down`}
              disabled={index() === props.chain.fallbacks.length - 1}
              onClick={() => move(index(), 1)}
            >
              ↓
            </button>
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              aria-label={`Remove fallback ${index() + 1}`}
              onClick={() => changeFallback(index(), null)}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <button
        class="btn btn--outline btn--sm"
        type="button"
        disabled={
          props.chain.fallbacks.length >= 5 ||
          options().length <= props.chain.fallbacks.length + (props.chain.route ? 1 : 0)
        }
        onClick={add}
      >
        Add fallback
      </button>
      <label class="preset-chain__mode">
        Response mode{' '}
        <select
          aria-label={`${props.title} response mode`}
          class="modal-card__input"
          value={props.chain.responseMode}
          onChange={(e) =>
            props.onChange({
              ...props.chain,
              responseMode: e.currentTarget.value as PresetChain['responseMode'],
            })
          }
        >
          <option value="buffered">Buffered</option>
          <option value="stream">Streaming</option>
        </select>
      </label>
    </fieldset>
  );
};

const RoutingPresets: Component<{
  agentName: string;
  models: AvailableModel[];
  providers?: RoutingProvider[];
  onApplied: () => Promise<unknown>;
}> = (props) => {
  const [presets, { refetch }] = createCachedResource(getRoutingPresets);
  const [selected, setSelected] = createSignal('');
  const [editing, setEditing] = createSignal<string | null>(null);
  const [name, setName] = createSignal('');
  const [draft, setDraft] = createSignal<RoutingPresetConfig | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const open = (id: string) => {
    setEditing(id);
    setError('');
    const preset = presets()?.find((p) => p.id === id);
    setName(preset?.name ?? '');
    setDraft(preset ? structuredClone(preset.config) : null);
  };
  const save = async () => {
    if (!name().trim() || busy()) return;
    setBusy(true);
    setError('');
    try {
      const saved =
        draft() && editing()
          ? await updateRoutingPreset(editing()!, name().trim(), draft()!)
          : await createRoutingPreset(name().trim(), props.agentName);
      await refetch();
      setSelected(saved.id);
      setEditing(null);
      toast.success('Routing preset saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save preset');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!selected() || busy()) return;
    setBusy(true);
    setError('');
    try {
      await applyRoutingPreset(selected(), props.agentName);
      await props.onApplied();
      toast.success('Preset copied to this harness');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply preset');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing() || busy()) return;
    setBusy(true);
    setError('');
    try {
      const id = editing()!;
      await deleteRoutingPreset(id);
      if (selected() === id) setSelected('');
      await refetch();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete preset');
    } finally {
      setBusy(false);
    }
  };
  const updateChain = (
    group: 'tiers' | 'specificity' | 'headers',
    index: number,
    chain: PresetChain,
  ) =>
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const tier = next[group][index];
      if (tier) Object.assign(tier, chain);
      return next;
    });
  return (
    <section class="routing-presets" aria-label="Routing presets">
      <div class="routing-presets__toolbar">
        <label for="routing-preset-choice">Preset</label>
        <Show
          when={!presets.loading || presets()}
          fallback={<span class="skeleton skeleton--text" style="width: 200px; height: 32px;" />}
        >
          <select
            id="routing-preset-choice"
            class="modal-card__input"
            value={selected()}
            disabled={busy()}
            onChange={(e) => setSelected(e.currentTarget.value)}
          >
            <option value="">Choose a preset</option>
            <For each={presets() ?? []}>
              {(preset) => <option value={preset.id}>{preset.name}</option>}
            </For>
          </select>
        </Show>
        <button
          class="btn btn--outline btn--sm"
          type="button"
          disabled={!selected() || busy()}
          onClick={apply}
        >
          {busy() && editing() === null ? 'Applying…' : 'Apply copy'}
        </button>
        <button
          class="btn btn--ghost btn--sm"
          type="button"
          disabled={!selected() || busy()}
          onClick={() => open(selected())}
        >
          Edit preset
        </button>
        <button
          class="btn btn--outline btn--sm"
          type="button"
          disabled={busy()}
          onClick={() => open('')}
        >
          Save current as preset
        </button>
      </div>
      <p class="routing-presets__hint">
        Presets copy models, fallbacks, custom tiers and model settings. Editing a preset leaves
        existing harnesses unchanged.
      </p>
      <Show when={presets.error}>
        <p role="alert">
          Could not load presets.{' '}
          <button class="btn btn--ghost btn--sm" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={error() && editing() === null}>
        <p role="alert" class="preset-error">
          {error()}
        </p>
      </Show>
      <Show when={editing() !== null}>
        <div class="modal-overlay" onClick={() => !busy() && setEditing(null)}>
          <div
            class="modal-card routing-preset-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preset-dialog-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && !busy() && setEditing(null)}
          >
            <h2 id="preset-dialog-title">
              {draft() ? 'Edit routing preset' : 'Save routing preset'}
            </h2>
            <label class="preset-name">
              Preset name
              <input
                autofocus
                class="modal-card__input"
                maxlength="80"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <Show when={draft()}>
              {(config) => (
                <div class="routing-preset-modal__chains">
                  <label>
                    <input
                      type="checkbox"
                      checked={config().complexityRoutingEnabled}
                      onChange={(e) =>
                        setDraft((old) =>
                          old ? { ...old, complexityRoutingEnabled: e.currentTarget.checked } : old,
                        )
                      }
                    />{' '}
                    Route by complexity
                  </label>
                  <Show when={props.providers?.length}>
                    <details>
                      <summary>Provider connections</summary>
                      <For each={props.providers?.filter((provider) => provider.is_active)}>
                        {(provider) => (
                          <label>
                            <input
                              type="checkbox"
                              checked={config().providerIds.includes(provider.id)}
                              onChange={(e) => {
                                const checked = e.currentTarget.checked;
                                setDraft((old) =>
                                  old
                                    ? {
                                        ...old,
                                        providerIds: checked
                                          ? [...new Set([...old.providerIds, provider.id])]
                                          : old.providerIds.filter((id) => id !== provider.id),
                                      }
                                    : old,
                                );
                              }}
                            />{' '}
                            {provider.provider} · {provider.auth_type} ·{' '}
                            {provider.label || 'Default'}
                          </label>
                        )}
                      </For>
                    </details>
                  </Show>
                  <For each={config().tiers}>
                    {(tier, index) => (
                      <Show when={tier.tier === 'default' || config().complexityRoutingEnabled}>
                        <ChainEditor
                          title={tier.tier === 'default' ? 'Default' : tier.tier}
                          chain={tier}
                          models={props.models}
                          onChange={(chain) => updateChain('tiers', index(), chain)}
                        />
                      </Show>
                    )}
                  </For>
                  <Show when={config().specificity.length}>
                    <details>
                      <summary>Task routing</summary>
                      <For each={config().specificity}>
                        {(tier, index) => (
                          <div>
                            <label>
                              <input
                                type="checkbox"
                                checked={tier.active}
                                onChange={(e) =>
                                  setDraft((old) => {
                                    if (!old) return old;
                                    const next = structuredClone(old);
                                    next.specificity[index()]!.active = e.currentTarget.checked;
                                    return next;
                                  })
                                }
                              />{' '}
                              Enable {tier.category}
                            </label>
                            <Show when={tier.active}>
                              <ChainEditor
                                title={`Task: ${tier.category}`}
                                chain={tier}
                                models={props.models}
                                onChange={(chain) => updateChain('specificity', index(), chain)}
                              />
                            </Show>
                          </div>
                        )}
                      </For>
                    </details>
                  </Show>
                  <For each={config().headers}>
                    {(tier, index) => (
                      <ChainEditor
                        title={`Custom: ${tier.name}`}
                        chain={tier}
                        models={props.models}
                        onChange={(chain) => updateChain('headers', index(), chain)}
                      />
                    )}
                  </For>
                </div>
              )}
            </Show>
            <Show when={error()}>
              <p role="alert" class="preset-error">
                {error()}
              </p>
            </Show>
            <div class="modal-card__footer">
              <Show when={draft()}>
                <button
                  type="button"
                  class="btn btn--danger btn--sm"
                  disabled={busy()}
                  onClick={remove}
                >
                  Delete preset
                </button>
              </Show>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                disabled={busy()}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn--primary btn--sm"
                disabled={!name().trim() || busy()}
                onClick={save}
              >
                {busy() ? 'Saving…' : 'Save preset'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
};
export default RoutingPresets;
