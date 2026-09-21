import { NotFoundException } from '@nestjs/common';
import type { CustomProvider } from '../entities/custom-provider.entity';
import type { TenantProvider } from '../entities/tenant-provider.entity';
import type { DiscoveredModel } from '../model-discovery/model-fetcher';
import { ConnectionTestService, pickTestModel } from './connection-test.service';

const model = (over: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  id: 'cheap-1',
  displayName: 'Cheap 1',
  provider: 'openai',
  contextWindow: 128000,
  inputPricePerToken: 0.000001,
  outputPricePerToken: 0.000002,
  capabilityReasoning: false,
  capabilityCode: true,
  qualityScore: 50,
  ...over,
});

const connection = (over: Partial<TenantProvider> = {}): TenantProvider =>
  ({
    id: 'tp-1',
    tenant_id: 'tenant-1',
    created_by_user_id: null,
    agent_id: null,
    provider: 'openai',
    api_key_encrypted: 'ciphertext',
    key_prefix: 'sk-abc',
    auth_type: 'api_key',
    label: 'vc pro',
    priority: 0,
    region: null,
    is_active: true,
    connected_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    cached_models: [model()],
    models_fetched_at: '2026-09-01T00:00:00.000Z',
    manual_usage_limit_usd: null,
    cached_quota_report: null,
    cached_quota_at: null,
    ...over,
  }) as TenantProvider;

/** Minimal stand-in for the fetch `Response` the real ProviderClient returns. */
function providerResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function harness(options?: {
  connections?: TenantProvider[];
  customProviders?: CustomProvider[];
  credential?: jest.Mock;
  forward?: jest.Mock;
  unwrapToken?: jest.Mock;
}) {
  const connections = options?.connections ?? [connection()];
  const providerRepo = {
    findOne: jest
      .fn()
      .mockImplementation(
        async ({ where }: { where: { id: string; tenant_id: string } }) =>
          connections.find((c) => c.id === where.id && c.tenant_id === where.tenant_id) ?? null,
      ),
  };
  const customProviders = options?.customProviders ?? [];
  const customProviderRepo = {
    findOne: jest
      .fn()
      .mockImplementation(
        async ({ where }: { where: { id: string; tenant_id: string } }) =>
          customProviders.find((c) => c.id === where.id && c.tenant_id === where.tenant_id) ?? null,
      ),
  };
  const credential = options?.credential ?? jest.fn().mockResolvedValue('sk-live-secret');
  const providerKeys = { getOwnedProviderCredentialById: credential };
  const forward =
    options?.forward ?? jest.fn().mockResolvedValue({ response: providerResponse(200) });
  const providerClient = { forward };
  // `api_key` rows short-circuit inside resolveApiKey before any OAuth service
  // is touched; only the `subscription` cases below reach unwrapToken.
  const oauth = { unwrapToken: options?.unwrapToken ?? jest.fn().mockResolvedValue(null) };
  const service = new ConnectionTestService(
    providerRepo as never,
    customProviderRepo as never,
    providerKeys as never,
    providerClient as never,
    oauth as never,
    oauth as never,
    oauth as never,
    oauth as never,
    oauth as never,
    oauth as never,
  );
  return { service, providerRepo, customProviderRepo, credential, forward, oauth };
}

describe('ConnectionTestService', () => {
  it('404s an id that names no connection in this tenant', async () => {
    const { service, providerRepo } = harness();

    await expect(service.test('tenant-1', 'tp-missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(providerRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'tp-missing', tenant_id: 'tenant-1' },
    });
  });

  it('404s a user with no tenant without ever querying for the connection', async () => {
    const { service, providerRepo } = harness();

    await expect(service.test(null, 'tp-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(providerRepo.findOne).not.toHaveBeenCalled();
  });

  it('reports untestable when no models have been discovered yet', async () => {
    const { service, credential } = harness({
      connections: [connection({ cached_models: null })],
    });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({
      connection_id: 'tp-1',
      provider: 'openai',
      label: 'vc pro',
      status: 'untestable',
      model: null,
      latency_ms: null,
      http_status: null,
    });
    expect(result.message).toContain('refresh models');
    expect(credential).not.toHaveBeenCalled();
  });

  it('reports needs_reconnect when the connection has no stored credential', async () => {
    const { service, forward } = harness({ credential: jest.fn().mockResolvedValue(null) });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({ status: 'needs_reconnect', model: null, http_status: null });
    expect(result.message).toContain('reconnect');
    expect(forward).not.toHaveBeenCalled();
  });

  it('reports needs_reconnect when a subscription token can no longer be refreshed', async () => {
    const blob = JSON.stringify({ t: 'access', r: 'refresh', e: 0 });
    const { service, forward, oauth } = harness({
      connections: [
        connection({ provider: 'anthropic', auth_type: 'subscription', label: 'Claude Max' }),
      ],
      credential: jest.fn().mockResolvedValue(blob),
      unwrapToken: jest.fn().mockResolvedValue(null),
    });

    const result = await service.test('tenant-1', 'tp-1');

    expect(oauth.unwrapToken).toHaveBeenCalledWith(
      blob,
      'connection-test',
      'tenant-1',
      'Claude Max',
    );
    expect(result).toMatchObject({ status: 'needs_reconnect' });
    expect(result.message).toContain('sign in to this account again');
    expect(forward).not.toHaveBeenCalled();
  });

  it('sends one non-streaming single-token ping and reports ok on a 2xx', async () => {
    const { service, forward, credential } = harness();

    const result = await service.test('tenant-1', 'tp-1');

    expect(credential).toHaveBeenCalledWith('tenant-1', 'tp-1');
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-live-secret',
        model: 'cheap-1',
        body: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        stream: false,
        apiMode: 'chat_completions',
        authType: 'api_key',
        signal: expect.any(AbortSignal),
      }),
    );
    // An api_key row carries no resource url, so no Gemini project id rides along.
    expect(forward.mock.calls[0][0]).not.toHaveProperty('providerResource');
    expect(result).toMatchObject({
      status: 'ok',
      model: 'cheap-1',
      http_status: 200,
      tested_at: expect.any(String),
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(result.message).toMatch(/^Replied in \d+ms\.$/);
  });

  it.each([401, 403])(
    'treats a %i as a credential problem, not a request problem',
    async (status) => {
      const forward = jest.fn().mockResolvedValue({
        response: providerResponse(status, JSON.stringify({ error: { message: 'Invalid token' } })),
      });
      const { service } = harness({ forward });

      const result = await service.test('tenant-1', 'tp-1');

      expect(result).toMatchObject({
        status: 'needs_reconnect',
        message: 'Invalid token',
        model: 'cheap-1',
        http_status: status,
      });
    },
  );

  it('reports failed and surfaces the provider error text on other non-2xx responses', async () => {
    const forward = jest.fn().mockResolvedValue({
      response: providerResponse(
        400,
        JSON.stringify({ error: { message: 'max_tokens must be >= 1' } }),
      ),
    });
    const { service } = harness({ forward });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({
      status: 'failed',
      message: 'max_tokens must be >= 1',
      model: 'cheap-1',
      http_status: 400,
    });
  });

  it('still reports a failure when the error body cannot be read', async () => {
    const response = {
      ok: false,
      status: 500,
      text: jest.fn().mockRejectedValue(new Error('stream closed')),
    } as unknown as Response;
    const { service } = harness({ forward: jest.fn().mockResolvedValue({ response }) });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({ status: 'failed', http_status: 500 });
    expect(result.message).toBe('Upstream provider internal error');
  });

  it('reports a timeout when the provider throws an AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const { service } = harness({ forward: jest.fn().mockRejectedValue(abortError) });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({
      status: 'failed',
      message: 'Provider did not respond within 20s.',
      model: 'cheap-1',
      http_status: null,
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
  });

  it('aborts a provider that never responds and reports the timeout', async () => {
    jest.useFakeTimers();
    try {
      const forward = jest.fn().mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('socket hang up')));
          }),
      );
      const { service } = harness({ forward });

      const pending = service.test('tenant-1', 'tp-1');
      await jest.advanceTimersByTimeAsync(20_000);

      await expect(pending).resolves.toMatchObject({
        status: 'failed',
        message: 'Provider did not respond within 20s.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a transport failure rather than throwing a Manifest 500', async () => {
    const { service } = harness({
      forward: jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.example.com')),
    });

    const result = await service.test('tenant-1', 'tp-1');

    expect(result).toMatchObject({
      status: 'failed',
      message: 'Could not reach the provider.',
      model: 'cheap-1',
      http_status: null,
    });
  });

  it('forwards a custom connection through its own tenant-owned endpoint', async () => {
    const { service, customProviderRepo, forward } = harness({
      connections: [
        connection({
          provider: 'custom:11111111-2222-3333-4444-555555555555',
          cached_models: [model({ id: 'local-mini', provider: 'custom' })],
        }),
      ],
      customProviders: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          tenant_id: 'tenant-1',
          base_url: 'https://llm.internal.example.com/v1',
          api_kind: 'openai',
        } as CustomProvider,
      ],
    });

    const result = await service.test('tenant-1', 'tp-1');

    expect(customProviderRepo.findOne).toHaveBeenCalledWith({
      where: { id: '11111111-2222-3333-4444-555555555555', tenant_id: 'tenant-1' },
    });
    expect(forward.mock.calls[0][0].customEndpoint).toMatchObject({
      baseUrl: 'https://llm.internal.example.com',
      format: 'openai',
    });
    expect(result).toMatchObject({ status: 'ok', model: 'local-mini' });
  });

  it('carries the Gemini CodeAssist project id as providerResource', async () => {
    const blob = JSON.stringify({ t: 'access', r: 'refresh', e: 0, u: 'codeassist-project-9' });
    const { service, forward } = harness({
      connections: [
        connection({
          provider: 'gemini',
          auth_type: 'subscription',
          label: 'vc pro 3',
          cached_models: [model({ id: 'gemini-flash', provider: 'gemini' })],
        }),
      ],
      credential: jest.fn().mockResolvedValue(blob),
      unwrapToken: jest.fn().mockResolvedValue('fresh-access-token'),
    });

    const result = await service.test('tenant-1', 'tp-1');

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'fresh-access-token',
        authType: 'subscription',
        providerResource: 'codeassist-project-9',
      }),
    );
    expect(result).toMatchObject({ status: 'ok', model: 'gemini-flash' });
  });

  it('does not attach providerResource for a non-Gemini subscription', async () => {
    const resourceUrl = 'https://api.minimax.io/anthropic/v1';
    const blob = JSON.stringify({ t: 'access', r: 'refresh', e: 0, u: resourceUrl });
    const { service, forward } = harness({
      connections: [connection({ provider: 'minimax', auth_type: 'subscription' })],
      credential: jest.fn().mockResolvedValue(blob),
      unwrapToken: jest.fn().mockResolvedValue({ t: 'fresh', u: resourceUrl }),
    });

    await service.test('tenant-1', 'tp-1');

    expect(forward.mock.calls[0][0]).not.toHaveProperty('providerResource');
  });
});

describe('pickTestModel', () => {
  it('returns null when the connection has never discovered models', () => {
    expect(pickTestModel(null)).toBeNull();
    expect(pickTestModel([])).toBeNull();
  });

  it('returns null when nothing on the connection can emit text', () => {
    expect(pickTestModel([model({ id: 'dalle', outputModalities: ['image'] })])).toBeNull();
  });

  it('picks the cheapest text-capable model and ignores image-only ones', () => {
    const picked = pickTestModel([
      model({ id: 'image', outputModalities: ['image'], inputPricePerToken: 0 }),
      model({ id: 'pricey', inputPricePerToken: 0.001, outputPricePerToken: 0.002 }),
      model({ id: 'cheapest', inputPricePerToken: 0.0000001, outputPricePerToken: 0 }),
      model({ id: 'text-tagged', outputModalities: ['text'], inputPricePerToken: 0.0005 }),
    ]);

    expect(picked?.id).toBe('cheapest');
  });

  it('breaks an all-zero price tie on quality score so subscriptions pick deterministically', () => {
    // Subscription connections carry no per-token pricing at all.
    const picked = pickTestModel([
      model({ id: 'opus', inputPricePerToken: null, outputPricePerToken: null, qualityScore: 95 }),
      model({ id: 'haiku', inputPricePerToken: null, outputPricePerToken: null, qualityScore: 40 }),
      model({
        id: 'sonnet',
        inputPricePerToken: null,
        outputPricePerToken: null,
        qualityScore: 70,
      }),
    ]);

    expect(picked?.id).toBe('haiku');
  });

  it('keeps the incumbent when a later candidate is strictly worse on both keys', () => {
    const picked = pickTestModel([
      model({ id: 'first', inputPricePerToken: 0, outputPricePerToken: 0, qualityScore: 10 }),
      model({ id: 'second', inputPricePerToken: 0.5, outputPricePerToken: 0.5, qualityScore: 99 }),
    ]);

    expect(picked?.id).toBe('first');
  });
});
