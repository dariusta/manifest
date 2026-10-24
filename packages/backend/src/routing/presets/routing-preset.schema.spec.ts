import { parsePresetConfig } from './routing-preset.schema';

const route = { model: 'model-a', provider: 'openai', authType: 'api_key' };
const fixture = () => ({
  version: 1,
  complexityRoutingEnabled: false,
  providerIds: ['connection-a'],
  tiers: [
    { tier: 'default', route, fallbacks: [], responseMode: 'buffered', outputModality: 'text' },
  ],
  specificity: [],
  headers: [],
  modelParams: [],
});

describe('routing preset validation', () => {
  it('rejects edits that remove every primary model', () => {
    expect(() => parsePresetConfig({ ...fixture(), tiers: [] })).toThrow('primary model');
  });
  it('rejects duplicate routes and more than five fallbacks', () => {
    const config = fixture();
    expect(() =>
      parsePresetConfig({ ...config, tiers: [{ ...config.tiers[0], fallbacks: [route] }] }),
    ).toThrow('Duplicate model routes');
    expect(() =>
      parsePresetConfig({
        ...config,
        tiers: [{ ...config.tiers[0], fallbacks: Array(6).fill(route) }],
      }),
    ).toThrow('Invalid routing preset');
  });
  it('rejects duplicate connection and parameter keys before database writes', () => {
    expect(() => parsePresetConfig({ ...fixture(), providerIds: ['a', 'a'] })).toThrow(
      'Duplicate provider',
    );
    const params = { scope: 'default', ...route, params: { temperature: 0.2 } };
    expect(() => parsePresetConfig({ ...fixture(), modelParams: [params, params] })).toThrow(
      'Duplicate model parameter',
    );
  });
  it('rejects orphan parameter scopes and reserved custom headers', () => {
    expect(() =>
      parsePresetConfig({
        ...fixture(),
        modelParams: [{ scope: 'header:missing', ...route, params: {} }],
      }),
    ).toThrow('Invalid model parameter scope');
    expect(() =>
      parsePresetConfig({
        ...fixture(),
        headers: [
          {
            ...fixture().tiers[0],
            sourceId: 'header-a',
            name: 'Auth',
            headerKey: 'authorization',
            headerValue: 'secret',
            badgeColor: 'blue',
            sortOrder: 0,
            enabled: true,
          },
        ],
      }),
    ).toThrow('Reserved header');
  });
});
