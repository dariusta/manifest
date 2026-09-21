import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomProvider } from '../entities/custom-provider.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import type { DiscoveredModel } from '../model-discovery/model-fetcher';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import { AnthropicOauthService } from '../routing/oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../routing/oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../routing/oauth/kiro/kiro-oauth.service';
import { MinimaxOauthService } from '../routing/oauth/minimax/minimax-oauth.service';
import { OpenaiOauthService } from '../routing/oauth/openai/openai-oauth.service';
import { XaiOauthService } from '../routing/oauth/xai/xai-oauth.service';
import { resolveForwardEndpoint } from '../routing/proxy/forward-endpoint-resolver';
import { resolveApiKey } from '../routing/proxy/oauth-credentials';
import { ProviderClient } from '../routing/proxy/provider-client';
import { sanitizeProviderError } from '../routing/proxy/proxy-error-sanitizer';
import { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import type { ConnectionTestResult, ConnectionTestStatus } from './connection-test.types';

/**
 * Refresh logs are keyed by agent. A connection test is a tenant-level
 * diagnostic with no agent behind it, so it reports itself rather than
 * borrowing an agent id — same convention as `PLAN_USAGE_AGENT_ID`.
 */
const CONNECTION_TEST_AGENT_ID = 'connection-test';

/** Hard ceiling on the ping. A hung provider must not hold the request open. */
const TEST_TIMEOUT_MS = 20_000;

/** Body of the ping. One token out is enough to prove the credential works. */
const PING_BODY = Object.freeze({
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
});

@Injectable()
export class ConnectionTestService {
  private readonly logger = new Logger(ConnectionTestService.name);

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly providerKeys: ProviderKeyService,
    private readonly providerClient: ProviderClient,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
  ) {}

  /**
   * Send one real, non-streaming completion through this exact connection.
   *
   * Scoped to a single `tenant_providers` row on purpose: `getOwnedProviderCredentialById`
   * is the seam that never falls through to a sibling or borrowed credential,
   * so a green result proves *this* account works rather than "some account on
   * this provider works".
   *
   * Nothing is recorded. This calls `ProviderClient.forward()` directly rather
   * than `ProxyService.proxyRequest()`, so a diagnostic never lands in
   * `requests` / `agent_messages` and never skews provider reliability metrics.
   */
  async test(tenantId: string | null, connectionId: string): Promise<ConnectionTestResult> {
    // A user with no tenant yet owns no connections, so there is nothing this
    // id could name — same 404 a wrong id gets, and never a cross-tenant read.
    const connection = tenantId
      ? await this.providerRepo.findOne({ where: { id: connectionId, tenant_id: tenantId } })
      : null;
    if (!connection || !tenantId) throw new NotFoundException('Connection not found');

    const base = {
      connection_id: connection.id,
      provider: connection.provider,
      label: connection.label,
      tested_at: new Date().toISOString(),
    };
    const done = (
      status: ConnectionTestStatus,
      message: string,
      extra: Partial<ConnectionTestResult> = {},
    ): ConnectionTestResult => ({
      ...base,
      status,
      message,
      model: null,
      latency_ms: null,
      http_status: null,
      ...extra,
    });

    const model = pickTestModel(connection.cached_models);
    if (!model) {
      return done(
        'untestable',
        'No models discovered for this connection yet — refresh models, then test again.',
      );
    }

    const rawCredential = await this.providerKeys.getOwnedProviderCredentialById(
      tenantId,
      connection.id,
    );
    if (!rawCredential) {
      return done('needs_reconnect', 'No stored credential for this account — reconnect it.');
    }

    // Refresh the same way the proxy does. Without this a merely-expired access
    // token reports a red test while inference would have worked fine.
    const resolved = await resolveApiKey(
      connection.provider,
      rawCredential,
      connection.auth_type,
      CONNECTION_TEST_AGENT_ID,
      tenantId,
      this.openaiOauth,
      this.minimaxOauth,
      this.anthropicOauth,
      this.geminiOauth,
      this.kiroOauth,
      this.xaiOauth,
      connection.label,
    );
    if (!resolved.apiKey) {
      return done(
        'needs_reconnect',
        'Stored credential could not be refreshed — sign in to this account again.',
      );
    }

    const customProvider = CustomProviderService.isCustom(connection.provider)
      ? await this.customProviderRepo.findOne({
          where: {
            id: CustomProviderService.extractId(connection.provider),
            tenant_id: tenantId,
          },
        })
      : null;

    const { customEndpoint, forwardModel } = resolveForwardEndpoint({
      provider: connection.provider,
      authType: connection.auth_type,
      model: model.id,
      providerRegion: connection.region,
      resourceUrl: connection.auth_type === 'subscription' ? resolved.resourceUrl : undefined,
      customProvider,
      logger: this.logger,
    });

    // Gemini OAuth stores the CodeAssist project id (not a URL) in the same
    // `u` slot; it rides as providerResource, matching the proxy and playground.
    const providerResource =
      connection.auth_type === 'subscription' && connection.provider.toLowerCase() === 'gemini'
        ? resolved.resourceUrl
        : undefined;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const forward = await this.providerClient.forward({
        provider: connection.provider,
        apiKey: resolved.apiKey,
        model: forwardModel,
        body: { ...PING_BODY },
        stream: false,
        apiMode: 'chat_completions',
        authType: connection.auth_type,
        customEndpoint,
        signal: abort.signal,
        ...(providerResource ? { providerResource } : {}),
      });

      const latency = Date.now() - startedAt;
      const status = forward.response.status;
      if (forward.response.ok) {
        return done('ok', `Replied in ${latency}ms.`, {
          model: forwardModel,
          latency_ms: latency,
          http_status: status,
        });
      }

      const body = await forward.response.text().catch(() => '');
      const message = sanitizeProviderError(status, body, process.env.NODE_ENV);
      // 401/403 is the credential, not the request — point at reconnecting
      // rather than leaving the user to decode a provider auth error.
      const isAuth = status === 401 || status === 403;
      return done(isAuth ? 'needs_reconnect' : 'failed', message, {
        model: forwardModel,
        latency_ms: latency,
        http_status: status,
      });
    } catch (error) {
      const latency = Date.now() - startedAt;
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return done('failed', `Provider did not respond within ${TEST_TIMEOUT_MS / 1000}s.`, {
          model: forwardModel,
          latency_ms: latency,
        });
      }
      // A transport-level throw is still a real failure of this account's
      // route, so it is reported rather than surfaced as a Manifest 500.
      return done('failed', 'Could not reach the provider.', {
        model: forwardModel,
        latency_ms: latency,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Cheapest text-capable model on the connection.
 *
 * Price first, then quality score as the tie-break: subscription connections
 * (Gemini, Claude) carry no per-token pricing at all, so without the second key
 * every one of their models would tie at 0 and the pick would be arbitrary.
 */
export function pickTestModel(models: DiscoveredModel[] | null): DiscoveredModel | null {
  if (!Array.isArray(models) || models.length === 0) return null;
  const textCapable = models.filter(
    (m) => !m.outputModalities || m.outputModalities.includes('text'),
  );
  if (textCapable.length === 0) return null;
  return textCapable.reduce((best, candidate) =>
    rank(candidate) < rank(best) ||
    (rank(candidate) === rank(best) && candidate.qualityScore < best.qualityScore)
      ? candidate
      : best,
  );
}

function rank(model: DiscoveredModel): number {
  return (model.inputPricePerToken ?? 0) + (model.outputPricePerToken ?? 0);
}
