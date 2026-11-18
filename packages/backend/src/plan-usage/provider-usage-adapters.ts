import { Injectable, Optional } from '@nestjs/common';
import type { TenantProvider } from '../entities/tenant-provider.entity';
import {
  buildAntigravitySubscriptionHeaders,
  buildClaudeCodeSubscriptionHeaders,
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
} from '../common/constants/subscription-clients';
import { parseOAuthTokenBlob } from '../routing/oauth/core';
import { isZaiProviderId } from '../routing/zai-region';

export type ProviderUsageStatus =
  'live' | 'cached' | 'manual' | 'unavailable' | 'unsupported' | 'needs_reconnect';

export interface ProviderQuotaWindow {
  name: string;
  usedPercent?: number;
  remainingPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  unit?: string;
}

export interface ProviderBalance {
  used?: number;
  limit?: number;
  remaining?: number;
  unit: string;
  unlimited?: boolean;
}

export interface ProviderOverage {
  enabled?: boolean;
  exhausted?: boolean;
  used?: number;
}

export interface ParsedProviderUsage {
  planName?: string;
  windows: ProviderQuotaWindow[];
  balance?: ProviderBalance;
  overage?: ProviderOverage;
}

export interface ProviderQuotaReport extends ParsedProviderUsage {
  status: ProviderUsageStatus;
  source: string;
  fetchedAt: string | null;
  message?: string;
}

type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface ProbeRequest {
  url: string;
  body?: string;
}

interface ProbeDefinition {
  source: string;
  authTypes?: TenantProvider['auth_type'][];
  url: (connection: TenantProvider) => string;
  /**
   * Further endpoints to try, in order, when the previous one answered
   * without usable data (non-2xx other than auth/rate-limit, or a body that
   * parses to nothing). Used where one credential may live in either of two
   * regions.
   */
  fallbackRequests?: (connection: TenantProvider) => ProbeRequest[];
  method: 'GET' | 'POST';
  headers: (credential: CredentialParts) => Record<string, string>;
  body?: (credential: CredentialParts, connection: TenantProvider) => string;
  parse: (body: unknown) => ParsedProviderUsage;
  /** Shown when every request came back without usage data. */
  unavailableMessage?: string;
}

interface CredentialParts {
  token: string;
  resource?: string;
  accountId?: string;
}

const TIMEOUT_MS = 8_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function percent(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed === undefined ? undefined : Math.min(100, Math.max(0, parsed));
}

function complement(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, 100 - value);
}

function isoTime(value: unknown, milliseconds = false): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const numeric = finite(value);
  if (numeric === undefined) return undefined;
  const date = new Date(milliseconds ? numeric : numeric * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ratioPercent(used: number | undefined, limit: number | undefined): number | undefined {
  return used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined;
}

function absoluteWindow(
  name: string,
  source: Record<string, unknown>,
  resetKey = 'resetTime',
): ProviderQuotaWindow {
  const limit = finite(source['limit']);
  const used = finite(source['used']);
  const remaining = finite(source['remaining']);
  const usedPercent = ratioPercent(used, limit);
  return {
    name,
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(usedPercent !== undefined
      ? { usedPercent, remainingPercent: complement(usedPercent) }
      : {}),
    ...(isoTime(source[resetKey]) ? { resetAt: isoTime(source[resetKey]) } : {}),
  };
}

export function parseAnthropicUsage(body: unknown): ParsedProviderUsage {
  const root = record(body) ?? {};
  const names: Array<[string, string]> = [
    ['five_hour', '5-hour'],
    ['seven_day', 'Weekly'],
    ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_omelette', 'Weekly · Fable'],
    ['seven_day_sonnet', 'Weekly · Sonnet'],
  ];
  const windows = names.flatMap(([key, name]) => {
    const bucket = record(root[key]);
    if (!bucket) return [];
    const usedPercent = percent(bucket['utilization']);
    if (usedPercent === undefined && !isoTime(bucket['resets_at'])) return [];
    return [
      {
        name,
        ...(usedPercent !== undefined
          ? { usedPercent, remainingPercent: complement(usedPercent) }
          : {}),
        ...(isoTime(bucket['resets_at']) ? { resetAt: isoTime(bucket['resets_at']) } : {}),
      },
    ];
  });
  const extra = record(root['extra_usage']);
  const limit = finite(extra?.['monthly_limit']);
  const used = finite(extra?.['used_credits']);
  const remaining =
    limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined;
  return {
    windows,
    ...(typeof root['subscription_type'] === 'string'
      ? { planName: root['subscription_type'] }
      : {}),
    ...(extra && (limit !== undefined || used !== undefined)
      ? {
          balance: {
            ...(limit !== undefined ? { limit } : {}),
            ...(used !== undefined ? { used } : {}),
            ...(remaining !== undefined ? { remaining } : {}),
            unit: 'USD',
          },
        }
      : {}),
    ...(extra ? { overage: { enabled: extra['is_enabled'] === true } } : {}),
  };
}

function openAiWindow(value: unknown): ProviderQuotaWindow | null {
  const bucket = record(value);
  if (!bucket) return null;
  const usedPercent = percent(bucket['used_percent']);
  if (usedPercent === undefined) return null;
  const seconds = finite(bucket['limit_window_seconds']);
  const name = seconds === 18_000 ? '5-hour' : seconds === 604_800 ? '7-day' : 'rate limit';
  return {
    name,
    usedPercent,
    remainingPercent: complement(usedPercent),
    ...(isoTime(bucket['reset_at']) ? { resetAt: isoTime(bucket['reset_at']) } : {}),
  };
}

export function parseOpenAiUsage(body: unknown): ParsedProviderUsage {
  const root = record(body) ?? {};
  const rateLimit = record(root['rate_limit']) ?? {};
  const windows = [
    openAiWindow(rateLimit['primary_window']),
    openAiWindow(rateLimit['secondary_window']),
  ].filter((value): value is ProviderQuotaWindow => value !== null);
  const credits = record(root['credits']);
  const balance = finite(credits?.['balance']);
  return {
    windows,
    ...(typeof root['plan_type'] === 'string' ? { planName: root['plan_type'] } : {}),
    ...(credits && (balance !== undefined || credits['unlimited'] === true)
      ? {
          balance: {
            ...(balance !== undefined ? { remaining: balance } : {}),
            unit: 'USD',
            unlimited: credits['unlimited'] === true,
          },
        }
      : {}),
    ...(typeof rateLimit['limit_reached'] === 'boolean'
      ? { overage: { exhausted: rateLimit['limit_reached'] } }
      : {}),
  };
}

export function parseGeminiUsage(body: unknown): ParsedProviderUsage {
  const buckets = record(body)?.['buckets'];
  return {
    windows: Array.isArray(buckets)
      ? buckets.flatMap((raw) => {
          const bucket = record(raw);
          if (!bucket || typeof bucket['modelId'] !== 'string') return [];
          const remainingFraction = finite(bucket['remainingFraction']);
          if (remainingFraction === undefined) return [];
          const remainingPercent = Math.min(100, Math.max(0, remainingFraction * 100));
          return [
            {
              name: bucket['modelId'],
              remainingPercent,
              usedPercent: complement(remainingPercent),
              ...(isoTime(bucket['resetTime']) ? { resetAt: isoTime(bucket['resetTime']) } : {}),
            },
          ];
        })
      : [],
  };
}

export function parseMetaUsage(body: unknown): ParsedProviderUsage {
  const root = record(body) ?? {};
  const data = root['data'];
  const models = Array.isArray(data) ? data : [];
  if (models.length === 0) return { windows: [] };
  return {
    planName: 'Muse Code',
    windows: [{ name: 'Muse Code models', remainingPercent: 100, usedPercent: 0 }],
  };
}

export function parseCopilotUsage(body: unknown): ParsedProviderUsage {
  const root = record(body) ?? {};
  const snapshots = record(root['quota_snapshots']) ?? {};
  let overageEnabled = false;
  let overageUsed = 0;
  const windows = Object.entries(snapshots).flatMap(([name, raw]) => {
    const quota = record(raw);
    if (!quota) return [];
    const limit = finite(quota['entitlement']);
    const remaining = finite(quota['remaining'] ?? quota['quota_remaining']);
    const remainingPercent = percent(quota['percent_remaining']);
    const unlimited = quota['unlimited'] === true;
    const overage = finite(quota['overage_count']) ?? 0;
    overageEnabled ||= quota['overage_permitted'] === true;
    overageUsed += overage;
    const used =
      limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined;
    return [
      {
        name: name.replaceAll('_', ' '),
        ...(limit !== undefined ? { limit } : {}),
        ...(used !== undefined ? { used } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(remainingPercent !== undefined
          ? { remainingPercent, usedPercent: complement(remainingPercent) }
          : {}),
        ...(isoTime(root['quota_reset_date_utc'] ?? root['quota_reset_date'])
          ? { resetAt: isoTime(root['quota_reset_date_utc'] ?? root['quota_reset_date']) }
          : {}),
        ...(unlimited ? { unit: 'unlimited' } : {}),
      },
    ];
  });
  return {
    windows,
    ...(typeof root['copilot_plan'] === 'string' ? { planName: root['copilot_plan'] } : {}),
    ...(overageEnabled || overageUsed > 0
      ? { overage: { enabled: overageEnabled, used: overageUsed } }
      : {}),
  };
}

export function parseKimiUsage(body: unknown): ParsedProviderUsage {
  const root = record(body) ?? {};
  const windows: ProviderQuotaWindow[] = [];
  const usage = record(root['usage']);
  if (usage) windows.push(absoluteWindow('7-day', usage));
  if (Array.isArray(root['limits'])) {
    for (const raw of root['limits']) {
      const limit = record(raw);
      const detail = record(limit?.['detail']);
      if (!limit) continue;
      const window = record(limit['window']);
      const duration = finite(window?.['duration']);
      const unit = window?.['timeUnit'];
      const name = duration === 300 && unit === 'TIME_UNIT_MINUTE' ? '5-hour' : 'rate limit';
      if (detail) windows.push(absoluteWindow(name, detail));
      else if (name === '5-hour') windows.push({ name, usedPercent: 0, remainingPercent: 100 });
    }
  }
  return {
    windows,
    ...(typeof root['membershipLevel'] === 'string' ? { planName: root['membershipLevel'] } : {}),
  };
}

const ZAI_LIMIT_NAMES: Record<string, string> = {
  TOKENS_LIMIT: 'tokens',
  TIME_LIMIT: 'time limit',
  RATE_LIMIT: 'rate limit',
  TIMES_LIMIT: 'requests',
  SESSION_LIMIT: 'sessions',
  CREDIT_LIMIT: 'credit limit',
};

/**
 * Z.ai reports its rolling and long windows under one `type`, so a coding plan
 * comes back as two "credit limit" rows. Each row carries its own cadence as
 * `unit` + `number` (`3`/`5` is the 5-hour window, `6`/`1` the weekly one).
 * Only units confirmed against live responses are named; anything else keeps
 * the provider's wording rather than guessing.
 *
 * The cadence must come from these fields, never from how far away the reset
 * is: a weekly window a few hours from its reset looks exactly like a 5-hour
 * window by that measure, which swapped the two labels.
 */
function zaiWindowCadence(unit: unknown, count: unknown): string | undefined {
  const size = finite(count);
  if (size === undefined || size <= 0 || !Number.isInteger(size)) return undefined;
  switch (finite(unit)) {
    case 3:
      return `${size}-hour`;
    case 6:
      return size === 1 ? 'Weekly' : `${size}-week`;
    default:
      return undefined;
  }
}

export function parseZaiUsage(body: unknown): ParsedProviderUsage {
  const envelope = record(body) ?? {};
  const root = record(envelope['data']) ?? envelope;
  const limits = root['limits'];
  const windows: ProviderQuotaWindow[] = Array.isArray(limits)
    ? limits.flatMap((raw) => {
        const limit = record(raw);
        if (!limit) return [];
        const usedPercent = percent(limit['percentage']);
        const remaining = finite(limit['remaining']);
        if (usedPercent === undefined && remaining === undefined) return [];
        const type = typeof limit['type'] === 'string' ? limit['type'] : 'RATE_LIMIT';
        const typeName = ZAI_LIMIT_NAMES[type] ?? type.toLowerCase().replaceAll('_', ' ');
        const cadence = zaiWindowCadence(limit['unit'], limit['number']);
        // `usage` is the window's allowance and `currentValue` what has been
        // spent against it (it can overshoot the allowance slightly).
        const allowance = finite(limit['usage']);
        const spent = finite(limit['currentValue']);
        return [
          {
            name: cadence ? `${cadence} ${typeName}` : typeName,
            ...(usedPercent !== undefined
              ? { usedPercent, remainingPercent: complement(usedPercent) }
              : {}),
            ...(allowance !== undefined ? { limit: allowance } : {}),
            ...(spent !== undefined ? { used: spent } : {}),
            ...(remaining !== undefined ? { remaining } : {}),
            ...(isoTime(limit['nextResetTime'], true)
              ? { resetAt: isoTime(limit['nextResetTime'], true) }
              : {}),
          },
        ];
      })
    : [];
  return {
    windows,
    ...(typeof root['level'] === 'string' ? { planName: root['level'] } : {}),
  };
}

/**
 * Alibaba's console wraps payloads in several envelopes (`data`,
 * `successResponse`, `DataV2`) and sometimes ships an inner object as a JSON
 * string, so look for a key anywhere in the tree instead of at a fixed path.
 */
function findDeep(value: unknown, key: string, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
      return findDeep(JSON.parse(trimmed), key, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  if (key in object) return object[key];
  for (const child of Object.values(object)) {
    const found = findDeep(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

const ALIBABA_ACTIVE_STATUSES = new Set(['VALID', 'ACTIVE']);

/** Prefer the instance the console marks active; fall back to the first one. */
function alibabaInstance(root: unknown): Record<string, unknown> | null {
  const infos = findDeep(root, 'codingPlanInstanceInfos');
  if (!Array.isArray(infos)) return null;
  const instances = infos.map(record).filter((info): info is Record<string, unknown> => !!info);
  return (
    instances.find((info) =>
      ALIBABA_ACTIVE_STATUSES.has(
        (firstString(info, ['status', 'instanceStatus']) ?? '').toUpperCase(),
      ),
    ) ??
    instances[0] ??
    null
  );
}

const ALIBABA_WINDOWS: Array<[string, string, string, string]> = [
  ['5-hour', 'per5HourUsedQuota', 'per5HourTotalQuota', 'per5HourQuotaNextRefreshTime'],
  ['Weekly', 'perWeekUsedQuota', 'perWeekTotalQuota', 'perWeekQuotaNextRefreshTime'],
  [
    'Monthly',
    'perBillMonthUsedQuota',
    'perBillMonthTotalQuota',
    'perBillMonthQuotaNextRefreshTime',
  ],
];

/**
 * Alibaba Cloud Model Studio Coding Plan quota, as the Model Studio console
 * reports it. Counts are requests per rolling 5-hour, weekly and billing-month
 * window. A response without counters (including the console's
 * `ConsoleNeedLogin` answer) parses to no data, so the probe reports the
 * usage as unavailable rather than inventing a 0%.
 */
export function parseAlibabaCodingPlanUsage(body: unknown): ParsedProviderUsage {
  const instance = alibabaInstance(body);
  const quota =
    record(instance?.['codingPlanQuotaInfo']) ?? record(findDeep(body, 'codingPlanQuotaInfo'));
  const windows: ProviderQuotaWindow[] = quota
    ? ALIBABA_WINDOWS.flatMap(([name, usedKey, totalKey, resetKey]) => {
        const limit = finite(quota[totalKey]);
        if (limit === undefined || limit <= 0) return [];
        const used = Math.max(0, finite(quota[usedKey]) ?? 0);
        const usedPercent = Math.min(100, (used / limit) * 100);
        const resetAt = isoTime(quota[resetKey], true);
        return [
          {
            name,
            limit,
            used,
            remaining: Math.max(0, limit - used),
            usedPercent,
            remainingPercent: complement(usedPercent),
            unit: 'requests',
            ...(resetAt ? { resetAt } : {}),
          },
        ];
      })
    : [];
  const planName = instance
    ? firstString(instance, ['planName', 'instanceName', 'packageName'])
    : undefined;
  // A plan name alone is not usage: report data only when there are counters.
  return windows.length > 0 ? { windows, ...(planName ? { planName } : {}) } : { windows: [] };
}

type AlibabaConsoleRegion = 'intl' | 'cn';

const ALIBABA_CONSOLES: Record<
  AlibabaConsoleRegion,
  { origin: string; regionId: string; commodityCode: string }
> = {
  intl: {
    origin: 'https://modelstudio.console.alibabacloud.com',
    regionId: 'ap-southeast-1',
    commodityCode: 'sfm_codingplan_public_intl',
  },
  cn: {
    origin: 'https://bailian.console.aliyun.com',
    regionId: 'cn-beijing',
    commodityCode: 'sfm_codingplan_public_cn',
  },
};

/**
 * Which console(s) to ask. An explicit mainland region or endpoint only asks
 * the mainland console, an explicit international one only the international
 * console; `auto` (or nothing) tries international first, then mainland.
 */
function alibabaConsoleRegions(region: string | null | undefined): AlibabaConsoleRegion[] {
  const value = (region ?? '').toLowerCase();
  if (value === 'beijing' || value.includes('cn-beijing') || value.includes('dashscope.aliyuncs')) {
    return ['cn'];
  }
  if (
    value === 'singapore' ||
    value === 'us' ||
    value.includes('ap-southeast') ||
    value.includes('dashscope-intl') ||
    value.includes('dashscope-us')
  ) {
    return ['intl'];
  }
  return ['intl', 'cn'];
}

function alibabaQuotaRequest(region: AlibabaConsoleRegion): ProbeRequest {
  const endpoint = ALIBABA_CONSOLES[region];
  const query = new URLSearchParams({
    action: 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2',
    product: 'broadscope-bailian',
    api: 'queryCodingPlanInstanceInfoV2',
    currentRegionId: endpoint.regionId,
  });
  return {
    url: `${endpoint.origin}/data/api.json?${query.toString()}`,
    body: JSON.stringify({
      queryCodingPlanInstanceInfoRequest: { commodityCode: endpoint.commodityCode },
    }),
  };
}

function credentialParts(raw: string): CredentialParts {
  const blob = parseOAuthTokenBlob(raw);
  const token = blob?.t ?? raw;
  return { token, ...(blob?.u ? { resource: blob.u } : {}), accountId: jwtAccountId(token) };
}

function jwtAccountId(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const auth = record(parsed?.['https://api.openai.com/auth']);
    const account = auth?.['chatgpt_account_id'];
    return typeof account === 'string' && account ? account : undefined;
  } catch {
    return undefined;
  }
}

const bearer = (credential: CredentialParts): Record<string, string> => ({
  Authorization: `Bearer ${credential.token}`,
  Accept: 'application/json',
});

const DEFINITIONS: Record<string, ProbeDefinition> = {
  anthropic: {
    source: 'anthropic_internal_oauth_usage',
    url: () => 'https://api.anthropic.com/api/oauth/usage',
    method: 'GET',
    headers: (credential) => buildClaudeCodeSubscriptionHeaders(credential.token),
    parse: parseAnthropicUsage,
  },
  openai: {
    source: 'openai_internal_codex_usage',
    url: () => 'https://chatgpt.com/backend-api/wham/usage',
    method: 'GET',
    headers: (credential) => ({
      ...bearer(credential),
      originator: CODEX_CLI_ORIGINATOR,
      'user-agent': CODEX_CLI_USER_AGENT,
      ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}),
    }),
    parse: parseOpenAiUsage,
  },
  gemini: {
    source: 'google_cloud_code_quota',
    url: () => 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    method: 'POST',
    headers: (credential) => buildAntigravitySubscriptionHeaders(credential.token),
    body: (credential) =>
      JSON.stringify(credential.resource ? { project: credential.resource } : {}),
    parse: parseGeminiUsage,
  },
  copilot: {
    source: 'github_copilot_internal_user',
    url: () => 'https://api.github.com/copilot_internal/user',
    method: 'GET',
    headers: (credential) => ({
      Authorization: `token ${credential.token}`,
      Accept: 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'User-Agent': 'GitHubCopilotChat',
      'X-Github-Api-Version': '2025-04-01',
    }),
    parse: parseCopilotUsage,
  },
  moonshot: {
    source: 'kimi_reverse_engineered_coding_usage',
    url: () => 'https://api.kimi.com/coding/v1/usages',
    method: 'GET',
    headers: bearer,
    parse: parseKimiUsage,
  },
  xai: {
    source: 'xai_cli_billing_credits',
    url: () => 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    method: 'GET',
    headers: (credential) => ({
      ...bearer(credential),
      'X-XAI-Token-Auth': 'xai-grok-cli',
    }),
    parse: (body) => {
      const root = record(body) ?? {};
      const config = record(root['config']) ?? {};
      const period = record(config['currentPeriod']) ?? {};
      const usedPercent = percent(config['creditUsagePercent']);
      const periodType = typeof period['type'] === 'string' ? period['type'] : '';
      const windows =
        usedPercent === undefined
          ? []
          : [
              {
                name: periodType.includes('WEEKLY') ? 'Weekly limit' : 'Monthly credits',
                usedPercent,
                remainingPercent: complement(usedPercent),
                ...(isoTime(period['end'] ?? config['billingPeriodEnd'])
                  ? { resetAt: isoTime(period['end'] ?? config['billingPeriodEnd']) }
                  : {}),
              },
            ];
      const prepaid = finite(record(config['prepaidBalance'])?.['val']);
      return {
        windows,
        ...(prepaid !== undefined ? { balance: { remaining: prepaid, unit: 'credits' } } : {}),
      };
    },
  },
  zai: {
    source: 'zai_reverse_engineered_monitor_quota',
    authTypes: ['subscription', 'api_key'],
    url: (connection) =>
      connection.region === 'cn'
        ? 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
        : 'https://api.z.ai/api/monitor/usage/quota/limit',
    method: 'GET',
    headers: bearer,
    parse: parseZaiUsage,
  },
  meta: {
    source: 'meta_model_api_catalog',
    authTypes: ['subscription', 'api_key'],
    url: () => 'https://api.meta.ai/v1/models',
    method: 'GET',
    headers: bearer,
    parse: parseMetaUsage,
  },
  qwen: {
    source: 'alibaba_model_studio_coding_plan_quota',
    url: (connection) => alibabaQuotaRequest(alibabaConsoleRegions(connection.region)[0]).url,
    fallbackRequests: (connection) =>
      alibabaConsoleRegions(connection.region).slice(1).map(alibabaQuotaRequest),
    method: 'POST',
    headers: (credential) => ({
      ...bearer(credential),
      'Content-Type': 'application/json',
      'x-api-key': credential.token,
      'X-DashScope-API-Key': credential.token,
    }),
    body: (_credential, connection) =>
      alibabaQuotaRequest(alibabaConsoleRegions(connection.region)[0]).body!,
    parse: parseAlibabaCodingPlanUsage,
    unavailableMessage:
      'Alibaba Cloud did not share plan usage for this key; it may only show it in the Model Studio console',
  },
};

/** Provider ids that share another provider's probe. */
const DEFINITION_ALIASES: Record<string, string> = { alibaba: 'qwen' };

function definitionFor(provider: string): ProbeDefinition | undefined {
  if (isZaiProviderId(provider)) return DEFINITIONS['zai'];
  return DEFINITIONS[DEFINITION_ALIASES[provider] ?? provider];
}

@Injectable()
export class ProviderUsageAdapterRegistry {
  constructor(@Optional() private readonly injectedFetchFn?: FetchLike) {}

  private get fetchFn(): FetchLike {
    return this.injectedFetchFn ?? (fetch as FetchLike);
  }

  async probe(
    connection: TenantProvider,
    loadCredential: () => Promise<string | null>,
  ): Promise<ProviderQuotaReport> {
    const definition = definitionFor(connection.provider.toLowerCase());
    const supportedAuthTypes = definition?.authTypes ?? ['subscription'];
    if (!definition || !supportedAuthTypes.includes(connection.auth_type)) {
      return {
        status: 'unsupported',
        source: 'manifest_observed_only',
        fetchedAt: null,
        windows: [],
        message: 'Provider balance unavailable',
      };
    }

    const rawCredential = await loadCredential();
    if (!rawCredential) {
      return {
        status: 'needs_reconnect',
        source: definition.source,
        fetchedAt: null,
        windows: [],
        message: 'Reconnect this provider to read plan usage',
      };
    }

    const credential = credentialParts(rawCredential);
    const requests: ProbeRequest[] = [
      {
        url: definition.url(connection),
        ...(definition.body ? { body: definition.body(credential, connection) } : {}),
      },
      ...(definition.fallbackRequests?.(connection) ?? []),
    ];
    for (const request of requests) {
      const report = await this.probeOnce(definition, credential, request);
      // Only "answered, but nothing usable" moves on to the next endpoint; an
      // auth rejection, rate limit or timeout is the answer for this key.
      if (report) return report;
    }
    return this.unavailable(definition.source, definition.unavailableMessage);
  }

  /** One request. Resolves null when the endpoint answered with no usable usage data. */
  private async probeOnce(
    definition: ProbeDefinition,
    credential: CredentialParts,
    request: ProbeRequest,
  ): Promise<ProviderQuotaReport | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchFn(request.url, {
        method: definition.method,
        headers: definition.headers(credential),
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'unavailable',
          source: definition.source,
          fetchedAt: null,
          windows: [],
          message: 'Usage endpoint did not accept this credential; inference may still work',
        };
      }
      if (response.status === 429) {
        return {
          status: 'unavailable',
          source: definition.source,
          fetchedAt: null,
          windows: [],
          message: 'Provider usage is rate limited',
        };
      }
      if (!response.ok) return null;
      const parsed = definition.parse(await response.json());
      const hasData =
        parsed.windows.length > 0 ||
        parsed.balance !== undefined ||
        parsed.planName !== undefined ||
        parsed.overage !== undefined;
      if (!hasData) return null;
      return {
        status: 'live',
        source: definition.source,
        fetchedAt: new Date().toISOString(),
        ...parsed,
      };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return {
          status: 'unavailable',
          source: definition.source,
          fetchedAt: null,
          windows: [],
          message: 'Provider usage request timed out',
        };
      }
      return this.unavailable(definition.source);
    } finally {
      clearTimeout(timeout);
    }
  }

  private unavailable(source: string, message?: string): ProviderQuotaReport {
    return {
      status: 'unavailable',
      source,
      fetchedAt: null,
      windows: [],
      message: message ?? 'Provider usage unavailable',
    };
  }
}
