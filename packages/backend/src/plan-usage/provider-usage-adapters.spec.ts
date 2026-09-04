import { Test } from '@nestjs/testing';
import type { TenantProvider } from '../entities/tenant-provider.entity';
import {
  ProviderUsageAdapterRegistry,
  parseAnthropicUsage,
  parseCopilotUsage,
  parseGeminiUsage,
  parseKimiUsage,
  parseOpenAiUsage,
  parseZaiUsage,
} from './provider-usage-adapters';

const connection = (over: Partial<TenantProvider>): TenantProvider =>
  ({
    id: 'tp-1',
    tenant_id: 'tenant-1',
    created_by_user_id: null,
    agent_id: null,
    provider: 'anthropic',
    api_key_encrypted: 'ciphertext',
    key_prefix: null,
    auth_type: 'subscription',
    label: 'Default',
    priority: 0,
    region: null,
    is_active: true,
    connected_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    cached_models: null,
    models_fetched_at: null,
    ...over,
  }) as TenantProvider;

describe('provider usage response parsers', () => {
  it('normalizes Anthropic rolling windows and extra usage', () => {
    expect(
      parseAnthropicUsage({
        five_hour: { utilization: 25, resets_at: '2026-09-02T05:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-09-08T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12.5 },
      }),
    ).toMatchObject({
      windows: [
        { name: '5-hour', usedPercent: 25, remainingPercent: 75 },
        { name: 'Weekly', usedPercent: 40, remainingPercent: 60 },
      ],
      balance: { limit: 100, used: 12.5, remaining: 87.5, unit: 'USD' },
      overage: { enabled: true },
    });
  });

  it('normalizes OpenAI plan, windows, credits, and reached state', () => {
    expect(
      parseOpenAiUsage({
        plan_type: 'plus',
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1780000000 },
          secondary_window: {
            used_percent: 70,
            limit_window_seconds: 604800,
            reset_at: 1780100000,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: '5.25' },
      }),
    ).toMatchObject({
      planName: 'plus',
      windows: [
        { name: '5-hour', usedPercent: 30, remainingPercent: 70 },
        { name: '7-day', usedPercent: 70, remainingPercent: 30 },
      ],
      balance: { remaining: 5.25, unit: 'USD' },
      overage: { exhausted: true },
    });
  });

  it('normalizes Gemini per-model remaining fractions without inventing absolute limits', () => {
    expect(
      parseGeminiUsage({
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: '2026-09-03T00:00:00Z' },
        ],
      }),
    ).toMatchObject({
      windows: [
        {
          name: 'gemini-2.5-pro',
          usedPercent: 20,
          remainingPercent: 80,
          resetAt: '2026-09-03T00:00:00.000Z',
        },
      ],
    });
  });

  it('normalizes Copilot quota snapshots including overage', () => {
    expect(
      parseCopilotUsage({
        copilot_plan: 'individual',
        quota_reset_date_utc: '2026-10-01T00:00:00Z',
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 120,
            percent_remaining: 40,
            unlimited: false,
            overage_count: 2,
            overage_permitted: true,
          },
        },
      }),
    ).toMatchObject({
      planName: 'individual',
      windows: [
        {
          name: 'premium interactions',
          limit: 300,
          used: 180,
          remaining: 120,
          usedPercent: 60,
          remainingPercent: 40,
        },
      ],
      overage: { enabled: true, used: 2 },
    });
  });

  it('normalizes Kimi weekly and 5-hour limits with numeric strings', () => {
    expect(
      parseKimiUsage({
        usage: { limit: '2048', used: '214', remaining: '1834', resetTime: '2026-09-08T00:00:00Z' },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: {
              limit: '200',
              used: '139',
              remaining: '61',
              resetTime: '2026-09-02T05:00:00Z',
            },
          },
        ],
      }),
    ).toMatchObject({
      windows: [
        { name: '7-day', limit: 2048, used: 214, remaining: 1834 },
        { name: '5-hour', limit: 200, used: 139, remaining: 61 },
      ],
    });
  });

  it('names repeated Z.ai credit windows by the cadence their reset implies', () => {
    const inFiveHours = Date.now() + 5 * 3_600_000;
    const inSixDays = Date.now() + 6 * 24 * 3_600_000;
    const parsed = parseZaiUsage({
      data: {
        level: 'max',
        limits: [
          { type: 'CREDIT_LIMIT', percentage: 15, nextResetTime: inFiveHours },
          { type: 'CREDIT_LIMIT', percentage: 48, nextResetTime: inSixDays },
        ],
      },
    });
    expect(parsed.windows.map((w) => w.name)).toEqual([
      '5-hour credit limit',
      'weekly credit limit',
    ]);
  });

  it('leaves a single Z.ai window under the provider wording', () => {
    const parsed = parseZaiUsage({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', percentage: 15, nextResetTime: Date.now() + 5 * 3_600_000 },
        ],
      },
    });
    expect(parsed.windows.map((w) => w.name)).toEqual(['credit limit']);
  });

  it('normalizes the grounded Z.ai monitor envelope', () => {
    expect(
      parseZaiUsage({
        data: {
          level: 'pro',
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: 18,
              remaining: 820000,
              nextResetTime: 1780000000000,
            },
          ],
        },
      }),
    ).toMatchObject({
      planName: 'pro',
      windows: [
        {
          name: 'tokens',
          usedPercent: 18,
          remainingPercent: 82,
          remaining: 820000,
        },
      ],
    });
  });
});

describe('ProviderUsageAdapterRegistry probes', () => {
  it('can be constructed by Nest without a fetch dependency token', async () => {
    const module = await Test.createTestingModule({
      providers: [ProviderUsageAdapterRegistry],
    }).compile();
    expect(module.get(ProviderUsageAdapterRegistry)).toBeInstanceOf(ProviderUsageAdapterRegistry);
  });

  it('uses the fixed Anthropic endpoint and subscription headers', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 1 } }),
    });
    const registry = new ProviderUsageAdapterRegistry(fetchFn as never);

    await registry.probe(connection({ provider: 'anthropic' }), async () => 'sk-ant-oat-secret');

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat-secret',
          'anthropic-beta': expect.stringContaining('oauth-2025-04-20'),
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    ['openai', 'https://chatgpt.com/backend-api/wham/usage', 'GET'],
    ['gemini', 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', 'POST'],
    ['copilot', 'https://api.github.com/copilot_internal/user', 'GET'],
    ['moonshot', 'https://api.kimi.com/coding/v1/usages', 'GET'],
    ['zai', 'https://api.z.ai/api/monitor/usage/quota/limit', 'GET'],
  ])('probes %s only at its fixed HTTPS endpoint', async (provider, endpoint, method) => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const registry = new ProviderUsageAdapterRegistry(fetchFn as never);

    await registry.probe(connection({ provider, region: 'global' }), async () =>
      provider === 'gemini'
        ? JSON.stringify({
            t: 'oauth-secret',
            r: 'refresh-secret',
            e: Date.now() + 1000,
            u: 'project-1',
          })
        : 'opaque-secret',
    );

    expect(fetchFn).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method }));
  });

  it('sends provider-specific auth headers and Gemini project body without leaking refresh tokens', async () => {
    const jwtPayload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
    ).toString('base64url');
    const cases = [
      {
        connection: connection({ provider: 'openai' }),
        credential: JSON.stringify({ t: `x.${jwtPayload}.y`, r: 'openai-refresh-secret', e: 1 }),
        header: ['Authorization', `Bearer x.${jwtPayload}.y`],
        extra: ['ChatGPT-Account-Id', 'acct-1'],
      },
      {
        connection: connection({ provider: 'gemini' }),
        credential: JSON.stringify({
          t: 'google-access',
          r: 'google-refresh-secret',
          e: 1,
          u: 'project-1',
        }),
        header: ['Authorization', 'Bearer google-access'],
        body: JSON.stringify({ project: 'project-1' }),
      },
      {
        connection: connection({ provider: 'copilot' }),
        credential: 'github-token',
        header: ['Authorization', 'token github-token'],
        extra: ['Editor-Version', expect.any(String)],
      },
      {
        connection: connection({ provider: 'moonshot' }),
        credential: 'kimi-token',
        header: ['Authorization', 'Bearer kimi-token'],
      },
      {
        connection: connection({ provider: 'zai' }),
        credential: 'zai-token',
        header: ['Authorization', 'Bearer zai-token'],
      },
    ];

    for (const item of cases) {
      const fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          item.connection.provider === 'gemini'
            ? { buckets: [{ modelId: 'm', remainingFraction: 1 }] }
            : item.connection.provider === 'copilot'
              ? { copilot_plan: 'individual' }
              : item.connection.provider === 'moonshot'
                ? { usage: { limit: 1, used: 0, remaining: 1 } }
                : item.connection.provider === 'zai'
                  ? { data: { level: 'pro' } }
                  : { plan_type: 'plus' },
      });
      const report = await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
        item.connection,
        async () => item.credential,
      );
      const init = fetchFn.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({
        [item.header[0] as string]: item.header[1],
        ...(item.extra ? { [item.extra[0] as string]: item.extra[1] } : {}),
      });
      if (item.body) expect(init.body).toBe(item.body);
      expect(JSON.stringify(init)).not.toContain('refresh-secret');
      expect(report.source).toMatch(/internal|cloud_code|reverse_engineered/);
    }
  });

  it('probes grounded Z.ai quota for an owned usage-based API key', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 25, remaining: 750 }] },
      }),
    });
    const registry = new ProviderUsageAdapterRegistry(fetchFn);

    const result = await registry.probe(
      connection({ provider: 'zai', auth_type: 'api_key' }),
      async () => 'zai-key',
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer zai-key' }),
      }),
    );
    expect(result.status).toBe('live');
  });

  it('does not claim inference credentials are invalid when only the private usage endpoint rejects them', async () => {
    const registry = new ProviderUsageAdapterRegistry(
      jest.fn().mockResolvedValue({ ok: false, status: 401 }) as never,
    );

    await expect(
      registry.probe(
        connection({ provider: 'anthropic' }),
        async () => 'still-valid-for-inference',
      ),
    ).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Usage endpoint did not accept this credential; inference may still work',
    });
  });

  it('returns needs_reconnect for a missing credential and never calls fetch', async () => {
    const fetchFn = jest.fn();
    const report = await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
      connection({ provider: 'openai' }),
      async () => null,
    );
    expect(report.status).toBe('needs_reconnect');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns unsupported without loading credentials for ungrounded providers', async () => {
    const loadCredential = jest.fn();
    const report = await new ProviderUsageAdapterRegistry(jest.fn() as never).probe(
      connection({ provider: 'mistral' }),
      loadCredential,
    );
    expect(report).toMatchObject({
      status: 'unsupported',
      message: 'Provider balance unavailable',
    });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('maps 429 and timeout to safe unavailable reports', async () => {
    const rateLimited = new ProviderUsageAdapterRegistry(
      jest.fn().mockResolvedValue({ ok: false, status: 429 }) as never,
    );
    await expect(
      rateLimited.probe(connection({ provider: 'moonshot' }), async () => 'secret'),
    ).resolves.toMatchObject({ status: 'unavailable', message: 'Provider usage is rate limited' });

    jest.useFakeTimers();
    const hangingFetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const timed = new ProviderUsageAdapterRegistry(hangingFetch as never);
    const pending = timed.probe(connection({ provider: 'moonshot' }), async () => 'secret');
    await jest.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Provider usage request timed out',
    });
    jest.useRealTimers();
  });

  it('never exposes a credential echoed by an upstream error', async () => {
    const secret = 'opaque-secret-value';
    const fetchFn = jest.fn().mockRejectedValue(new Error(`Authorization: Bearer ${secret}`));
    const report = await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
      connection({ provider: 'moonshot' }),
      async () => secret,
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report).toMatchObject({ status: 'unavailable', message: 'Provider usage unavailable' });
  });
});
