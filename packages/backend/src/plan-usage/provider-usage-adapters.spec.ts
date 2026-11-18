import { Test } from '@nestjs/testing';
import type { TenantProvider } from '../entities/tenant-provider.entity';
import {
  ProviderUsageAdapterRegistry,
  parseAlibabaCodingPlanUsage,
  parseAnthropicUsage,
  parseCopilotUsage,
  parseGeminiUsage,
  parseKimiUsage,
  parseMetaUsage,
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

  it('treats a live Muse Code catalog as remaining subscription quota', () => {
    expect(
      parseMetaUsage({
        data: [{ id: 'muse-spark-1.3' }, { id: 'muse-spark-1.2' }],
      }),
    ).toMatchObject({
      planName: 'Muse Code',
      windows: [{ name: 'Muse Code models', remainingPercent: 100, usedPercent: 0 }],
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

  it('names Z.ai credit windows by their unit/number cadence, not by time to reset', () => {
    // Shape of a live Max-plan response: the weekly window is spent and resets
    // in four hours, the 5-hour window is idle and has no reset yet. Judging by
    // time-to-reset labelled the weekly window "5-hour" and swapped the two.
    const parsed = parseZaiUsage({
      code: 200,
      data: {
        level: 'max',
        limits: [
          {
            type: 'CREDIT_LIMIT',
            unit: 3,
            number: 5,
            usage: 28000,
            currentValue: 0,
            remaining: 28000,
            percentage: 0,
          },
          {
            type: 'CREDIT_LIMIT',
            unit: 6,
            number: 1,
            usage: 140000,
            currentValue: 140180,
            remaining: 0,
            percentage: 100,
            nextResetTime: Date.now() + 4 * 3_600_000,
          },
        ],
      },
    });
    expect(parsed.windows).toMatchObject([
      {
        name: '5-hour credit limit',
        usedPercent: 0,
        remainingPercent: 100,
        limit: 28000,
        used: 0,
        remaining: 28000,
      },
      {
        name: 'Weekly credit limit',
        usedPercent: 100,
        remainingPercent: 0,
        limit: 140000,
        used: 140180,
        remaining: 0,
      },
    ]);
    expect(parsed.windows[0].resetAt).toBeUndefined();
    expect(parsed.windows[1].resetAt).toEqual(expect.any(String));
  });

  it('names multi-week Z.ai windows and keeps the provider wording for unknown units', () => {
    const parsed = parseZaiUsage({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 6, number: 2, percentage: 10 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 15 },
          { type: 'CREDIT_LIMIT', unit: 3, number: 0, percentage: 20 },
          { type: 'CREDIT_LIMIT', unit: 3, number: 1.5, percentage: 25 },
          { type: 'CREDIT_LIMIT', percentage: 30, nextResetTime: Date.now() + 3_600_000 },
        ],
      },
    });
    expect(parsed.windows.map((w) => w.name)).toEqual([
      '2-week credit limit',
      'time limit',
      'credit limit',
      'credit limit',
      'credit limit',
    ]);
  });

  it('parses Alibaba Coding Plan request windows from the active instance', () => {
    const parsed = parseAlibabaCodingPlanUsage({
      code: '200',
      data: {
        DataV2: JSON.stringify({
          codingPlanInstanceInfos: [
            {
              status: 'EXPIRED',
              planName: 'Old Lite',
              codingPlanQuotaInfo: { per5HourUsedQuota: 1, per5HourTotalQuota: 2 },
            },
            {
              status: 'valid',
              planName: 'Coding Plan Pro',
              codingPlanQuotaInfo: {
                per5HourUsedQuota: 1500,
                per5HourTotalQuota: 6000,
                per5HourQuotaNextRefreshTime: 1795053980000,
                perWeekUsedQuota: '50000',
                perWeekTotalQuota: '45000',
                perWeekQuotaNextRefreshTime: '2026-11-23T00:00:00Z',
                perBillMonthTotalQuota: 90000,
              },
            },
          ],
        }),
      },
    });
    expect(parsed).toEqual({
      planName: 'Coding Plan Pro',
      windows: [
        {
          name: '5-hour',
          limit: 6000,
          used: 1500,
          remaining: 4500,
          usedPercent: 25,
          remainingPercent: 75,
          unit: 'requests',
          resetAt: new Date(1795053980000).toISOString(),
        },
        {
          name: 'Weekly',
          limit: 45000,
          used: 50000,
          remaining: 0,
          usedPercent: 100,
          remainingPercent: 0,
          unit: 'requests',
          resetAt: '2026-11-23T00:00:00.000Z',
        },
        {
          name: 'Monthly',
          limit: 90000,
          used: 0,
          remaining: 90000,
          usedPercent: 0,
          remainingPercent: 100,
          unit: 'requests',
        },
      ],
    });
  });

  it('falls back to the first Alibaba instance and to a quota object outside it', () => {
    expect(
      parseAlibabaCodingPlanUsage({
        successResponse: {
          codingPlanInstanceInfos: [null, { instanceName: 'Lite' }],
          extra: [{ codingPlanQuotaInfo: { per5HourUsedQuota: 0, per5HourTotalQuota: 1200 } }],
        },
      }),
    ).toMatchObject({
      planName: 'Lite',
      windows: [{ name: '5-hour', limit: 1200, remaining: 1200 }],
    });
  });

  it.each([
    ['console login wall', { code: 'ConsoleNeedLogin', message: 'You need to log in.' }],
    ['plan without counters', { data: { codingPlanInstanceInfos: [{ planName: 'Lite' }] } }],
    ['zero allowance', { codingPlanQuotaInfo: { per5HourTotalQuota: 0 } }],
    ['non-object body', 'not json'],
    ['malformed embedded JSON', { data: '{not json' }],
    ['non-array instances', { codingPlanInstanceInfos: { status: 'VALID' } }],
  ])('reports no Alibaba usage for a %s', (_label, body) => {
    expect(parseAlibabaCodingPlanUsage(body)).toEqual({ windows: [] });
  });

  it('stops searching absurdly deep Alibaba payloads', () => {
    let nested: Record<string, unknown> = {
      codingPlanQuotaInfo: { per5HourUsedQuota: 0, per5HourTotalQuota: 10 },
    };
    for (let depth = 0; depth < 12; depth += 1) nested = { wrapper: nested };
    expect(parseAlibabaCodingPlanUsage(nested)).toEqual({ windows: [] });
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
    ['meta', 'https://api.meta.ai/v1/models', 'GET'],
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

  describe('Alibaba Cloud Coding Plan', () => {
    const INTL =
      'https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=ap-southeast-1';
    const CN =
      'https://bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=cn-beijing';
    const loginWall = {
      ok: true,
      status: 200,
      json: async () => ({ code: 'ConsoleNeedLogin', successResponse: false }),
    };
    const quota = {
      ok: true,
      status: 200,
      json: async () => ({
        data: { codingPlanQuotaInfo: { per5HourUsedQuota: 300, per5HourTotalQuota: 1200 } },
      }),
    };

    it('tries the international console, then mainland, sending the key and region body', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce(loginWall).mockResolvedValueOnce(quota);
      const report = await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
        connection({ provider: 'qwen', region: 'auto' }),
        async () => 'sk-sp-secret',
      );

      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([INTL, CN]);
      const [intlInit, cnInit] = fetchFn.mock.calls.map(([, init]) => init as RequestInit);
      expect(intlInit).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-sp-secret',
          'x-api-key': 'sk-sp-secret',
          'X-DashScope-API-Key': 'sk-sp-secret',
          'Content-Type': 'application/json',
        }),
      });
      expect(JSON.parse(intlInit.body as string)).toEqual({
        queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_intl' },
      });
      expect(JSON.parse(cnInit.body as string)).toEqual({
        queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn' },
      });
      expect(report).toMatchObject({
        status: 'live',
        source: 'alibaba_model_studio_coding_plan_quota',
        windows: [{ name: '5-hour', remaining: 900, remainingPercent: 75, unit: 'requests' }],
      });
    });

    it('stops at the first console that reports usage', async () => {
      const fetchFn = jest.fn().mockResolvedValue(quota);
      await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
        connection({ provider: 'qwen' }),
        async () => 'sk-sp-secret',
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(INTL, expect.anything());
    });

    it.each([
      ['beijing', [CN]],
      ['https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode', [CN]],
      ['singapore', [INTL]],
      ['us', [INTL]],
      ['https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode', [INTL]],
    ])('asks only the console matching region %s', async (region, urls) => {
      const fetchFn = jest.fn().mockResolvedValue(loginWall);
      await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
        connection({ provider: 'alibaba', region }),
        async () => 'sk-sp-secret',
      );
      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(urls);
      if (urls[0] === CN) {
        expect(JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)).toEqual({
          queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn' },
        });
      }
    });

    it('explains that Alibaba kept usage behind its console when no endpoint reports it', async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
        .mockResolvedValueOnce(loginWall);
      await expect(
        new ProviderUsageAdapterRegistry(fetchFn as never).probe(
          connection({ provider: 'qwen' }),
          async () => 'sk-sp-secret',
        ),
      ).resolves.toEqual({
        status: 'unavailable',
        source: 'alibaba_model_studio_coding_plan_quota',
        fetchedAt: null,
        windows: [],
        message:
          'Alibaba Cloud did not share plan usage for this key; it may only show it in the Model Studio console',
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not try the second console after an auth rejection', async () => {
      const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 403 });
      const report = await new ProviderUsageAdapterRegistry(fetchFn as never).probe(
        connection({ provider: 'qwen' }),
        async () => 'sk-sp-secret',
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(report.message).toBe(
        'Usage endpoint did not accept this credential; inference may still work',
      );
    });

    it('leaves pay-as-you-go DashScope keys unsupported', async () => {
      const loadCredential = jest.fn();
      await expect(
        new ProviderUsageAdapterRegistry(jest.fn() as never).probe(
          connection({ provider: 'qwen', auth_type: 'api_key' }),
          loadCredential,
        ),
      ).resolves.toMatchObject({ status: 'unsupported' });
      expect(loadCredential).not.toHaveBeenCalled();
    });
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
