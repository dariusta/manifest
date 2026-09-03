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

interface ProbeDefinition {
  source: string;
  authTypes?: TenantProvider['auth_type'][];
  url: (connection: TenantProvider) => string;
  method: 'GET' | 'POST';
  headers: (credential: CredentialParts) => Record<string, string>;
  body?: (credential: CredentialParts) => string;
  parse: (body: unknown) => ParsedProviderUsage;
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
};

export function parseZaiUsage(body: unknown): ParsedProviderUsage {
  const envelope = record(body) ?? {};
  const root = record(envelope['data']) ?? envelope;
  const limits = root['limits'];
  return {
    windows: Array.isArray(limits)
      ? limits.flatMap((raw) => {
          const limit = record(raw);
          if (!limit) return [];
          const usedPercent = percent(limit['percentage']);
          const remaining = finite(limit['remaining']);
          if (usedPercent === undefined && remaining === undefined) return [];
          const type = typeof limit['type'] === 'string' ? limit['type'] : 'RATE_LIMIT';
          return [
            {
              name: ZAI_LIMIT_NAMES[type] ?? type.toLowerCase().replaceAll('_', ' '),
              ...(usedPercent !== undefined
                ? { usedPercent, remainingPercent: complement(usedPercent) }
                : {}),
              ...(remaining !== undefined ? { remaining } : {}),
              ...(isoTime(limit['nextResetTime'], true)
                ? { resetAt: isoTime(limit['nextResetTime'], true) }
                : {}),
            },
          ];
        })
      : [],
    ...(typeof root['level'] === 'string' ? { planName: root['level'] } : {}),
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
    headers: (credential) =>
      buildClaudeCodeSubscriptionHeaders(credential.token, { includeOauthBeta: true }),
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
};

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
    const provider = connection.provider.toLowerCase();
    const definition = DEFINITIONS[isZaiProviderId(provider) ? 'zai' : provider];
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchFn(definition.url(connection), {
        method: definition.method,
        headers: definition.headers(credential),
        ...(definition.body ? { body: definition.body(credential) } : {}),
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
      if (!response.ok) return this.unavailable(definition.source);
      const parsed = definition.parse(await response.json());
      const hasData =
        parsed.windows.length > 0 ||
        parsed.balance !== undefined ||
        parsed.planName !== undefined ||
        parsed.overage !== undefined;
      if (!hasData) return this.unavailable(definition.source);
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

  private unavailable(source: string): ProviderQuotaReport {
    return {
      status: 'unavailable',
      source,
      fetchedAt: null,
      windows: [],
      message: 'Provider usage unavailable',
    };
  }
}
