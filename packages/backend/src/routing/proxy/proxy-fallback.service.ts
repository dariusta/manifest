import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import type { AuthType, ModelRoute } from 'manifest-shared';
import { applyRequestParamDefaults, isAnthropicExtraUsageError } from 'manifest-shared';
import { AgentModelParamsService } from '../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';

/**
 * Context for the per-attempt param-defaults merge. Carries the agentId so
 * `applyParamMerge` can ask the model-params service for the configuration
 * that belongs to this attempt's (provider, auth_type, model) tuple — not
 * the primary route's. Storage is model-scoped on the new
 * `agent_model_params` table, so cross-provider leak is structurally
 * impossible; we no longer need a provider-keyed filter, and Manifest's
 * old tier-aware opinion layer is gone too (only the user's explicit
 * config and the provider's natural default participate).
 */
export interface ParamMergeContext {
  agentId: string;
  scopeKey: string;
}

interface ForwardProviderOptions {
  provider: string;
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  resolveChatBody?: ResolveChatBody;
  stream: boolean;
  sessionKey: string;
  providerCacheKey?: string;
  signal?: AbortSignal;
  authType?: string;
  rawApiKey?: string;
  providerKeyLabel?: string;
  agentId?: string;
  tenantId?: string;
  resourceUrl?: string;
  providerRegion?: string | null;
  apiMode?: ProxyApiMode;
  signatureLookup?: SignatureLookup;
  thinkingLookup?: ThinkingBlockLookup;
  paramMergeContext?: ParamMergeContext;
  tenantProviderId?: string | null;
  startProviderAttempt?: StartProviderAttempt;
  inboundHeaders?: IncomingHttpHeaders;
}

import { ProviderKeyService } from '../routing-core/provider-key.service';
import { ProviderCredentialHealthService } from '../routing-core/provider-credential-health.service';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { CustomProviderService } from '../custom-provider/custom-provider.service';
import { resolveForwardEndpoint } from './forward-endpoint-resolver';
import { OpenaiOauthService } from '../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../oauth/xai/xai-oauth.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ProviderClient, ForwardResult } from './provider-client';
import { resolveEndpointKey } from './provider-endpoints';
import { CopilotTokenService } from './copilot-token.service';
import { ReasoningContentCache } from './reasoning-content-cache';
import { buildProviderExtraHeaders } from './provider-hooks';
import { shouldTriggerFallback } from './fallback-status-codes';
import { inferProviderFromModelName } from '../../common/utils/provider-aliases';
import { normalizeAnthropicShortModelId } from '../../common/utils/anthropic-model-id';
import {
  isTransportError,
  buildTransportErrorResponse,
  describeTransportError,
} from './proxy-transport';
import type {
  SignatureLookup,
  ThinkingBlockLookup,
  ResolveChatBody,
  ProviderAttemptRef,
  StartProviderAttempt,
} from './proxy-types';
import type { ProxyApiMode } from './proxy-types';
import { refreshRejectedOAuthCredential } from './oauth-credentials';
import {
  buildCredentialFailureFallback,
  presentCredentialFailure,
  resolveRouteCredentials,
  type RouteCredentialDeps,
} from './route-credentials';
import { recordingResponseFromText } from './attempt-recording-capture';

// NOTE: the provider rate-limit cooldown was removed deliberately. Manifest
// always dials the provider and surfaces the provider's own 429/529 verbatim;
// any Retry-After header is passed through untouched for the caller to honor.

const PROVIDER_ATTEMPT_REF = Symbol('providerAttemptRef');

type AttemptTaggedError = Error & { [PROVIDER_ATTEMPT_REF]?: ProviderAttemptRef };

function attemptFromError(error: unknown): ProviderAttemptRef | undefined {
  return error instanceof Error ? (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] : undefined;
}

export interface FailedFallback {
  model: string;
  provider: string;
  fallbackIndex: number;
  status: number;
  errorBody: string;
  // Auth used for this specific attempt. When the caller passes structured
  // routes the value is taken from the route; otherwise it falls back to the
  // legacy inference path. Either way the recorder can attribute the error
  // to the actual credential that failed instead of inheriting the primary's.
  authType?: AuthType;
  // The tenant_providers row that served this failed attempt, so the recorded
  // error row is scoped to the right connection. NULL for local/Ollama.
  tenantProviderId?: string | null;
  // Label of that same connection, so a failed hop records the key it used
  // instead of inheriting the primary's label.
  keyLabel?: string;
  attempt?: ProviderAttemptRef;
  /** False when the route was rejected locally (for example by a cooldown). */
  providerCallStarted?: boolean;
}

@Injectable()
export class ProxyFallbackService {
  private readonly logger = new Logger(ProxyFallbackService.name);

  constructor(
    private readonly providerKeyService: ProviderKeyService,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
    private readonly providerClient: ProviderClient,
    private readonly copilotToken: CopilotTokenService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly modelParamsService: AgentModelParamsService,
    private readonly providerParamSpecs: ProviderParamSpecService,
    private readonly reasoningCache: ReasoningContentCache,
    // Optional + last so positional test constructions keep working.
    @Optional()
    private readonly credentialHealth: ProviderCredentialHealthService | null = null,
  ) {}

  /**
   * Per-attempt merge: look up the user's saved params for this
   * (agent, provider, auth_type, model) tuple and fold them into the
   * outbound body. Returns the original body unchanged when no config
   * exists — the provider's natural default applies in that case.
   *
   * Async because saved values still live in the route-scoped params table;
   * the service caches the agent's full row set, so steady-state cost is a
   * Map lookup, not a query. The MPS catalog itself is static/fetched metadata.
   */
  private async applyParamMerge(
    body: Record<string, unknown>,
    ctx: ParamMergeContext | undefined,
    provider: string,
    authType: AuthType | string | undefined,
    model: string,
  ): Promise<Record<string, unknown>> {
    if (!ctx || !authType) return body;
    const modelParams = await this.modelParamsService.get(
      ctx.agentId,
      ctx.scopeKey,
      provider,
      authType as AuthType,
      model,
    );
    const specs = await this.providerParamSpecs.getSpecs(provider, authType as AuthType, model);
    return applyRequestParamDefaults(body, modelParams, specs);
  }

  async tryFallbacks(
    agentId: string,
    tenantId: string,
    fallbackModels: string[],
    body: Record<string, unknown>,
    stream: boolean,
    sessionKey: string,
    primaryModel: string,
    signal?: AbortSignal,
    primaryProvider?: string,
    primaryAuthType?: string,
    signatureLookup?: SignatureLookup,
    thinkingLookup?: ThinkingBlockLookup,
    apiMode?: ProxyApiMode,
    resolveChatBody?: ResolveChatBody,
    fallbackRoutes?: ModelRoute[] | null,
    paramMergeContext?: ParamMergeContext,
    startProviderAttempt?: StartProviderAttempt,
    /** Dashboard URL embedded in mid-chain M100/M102 credential failure bodies. */
    credentialDashboardUrl?: string,
    providerCacheKey?: string,
    inboundHeaders?: IncomingHttpHeaders,
  ): Promise<{
    success: {
      forward: ForwardResult;
      model: string;
      provider: string;
      fallbackIndex: number;
      authType?: AuthType;
      keyLabel?: string;
      tenantProviderId: string | null;
    } | null;
    failures: FailedFallback[];
  }> {
    const failures: FailedFallback[] = [];

    // Track auth types that already failed per provider so fallbacks for the
    // same provider try a different credential (fixes #1272). Only used on
    // the legacy inference path — when fallbackRoutes is present, the route's
    // explicit auth wins.
    const failedAuthByProvider = new Map<string, Set<string>>();
    if (primaryProvider && primaryAuthType) {
      failedAuthByProvider.set(primaryProvider.toLowerCase(), new Set([primaryAuthType]));
    }

    const useStructuredRoutes =
      Array.isArray(fallbackRoutes) && fallbackRoutes.length === fallbackModels.length;

    for (let i = 0; i < fallbackModels.length; i++) {
      const requestedModel = fallbackModels[i];
      const route = useStructuredRoutes ? fallbackRoutes![i] : null;
      let provider: string | undefined;
      let authType: AuthType;
      // Pinned key label: prefer the structured route's keyLabel. Each
      // fallback can be pinned to a specific provider key (e.g. "Work" vs
      // "Personal" Anthropic Console). When no label is supplied for a
      // subscription fallback, resolve the priority-0 key's label so OAuth
      // refresh persistence updates the same key getProviderApiKey selected.
      let providerKeyLabel = route?.keyLabel ?? undefined;

      if (route) {
        provider = route.provider;
        authType = route.authType;
      } else {
        const pricing = this.pricingCache.getByModel(requestedModel);
        if (CustomProviderService.isCustom(requestedModel)) {
          const slashIdx = requestedModel.indexOf('/');
          provider = slashIdx > 0 ? requestedModel.substring(0, slashIdx) : requestedModel;
        } else {
          const prefix = inferProviderFromModelName(requestedModel);
          provider =
            (prefix && (await this.providerKeyService.hasActiveProvider(tenantId, prefix, agentId))
              ? prefix
              : undefined) ??
            pricing?.provider ??
            (await this.providerKeyService.findProviderForModel(tenantId, requestedModel, agentId));
        }
        if (!provider) {
          this.logger.debug(`Fallback ${i}: skipping model=${requestedModel} (no provider data)`);
          continue;
        }
        const excludeAuth = failedAuthByProvider.get(provider.toLowerCase());
        authType = (await this.providerKeyService.getAuthType(
          tenantId,
          provider,
          excludeAuth,
          agentId,
        )) as AuthType;
      }
      const model = normalizeProviderModel(provider, requestedModel);
      // Same credential resolution as primary (select key + OAuth unwrap).
      const credentials = await resolveRouteCredentials(this.routeCredentialDeps(), {
        agentId,
        tenantId,
        provider,
        authType,
        providerKeyLabel,
      });
      if (!credentials.ok) {
        this.logger.debug(
          `Fallback ${i}: credential failure model=${model} provider=${provider} reason=${credentials.reason}`,
        );
        failures.push(
          buildCredentialFailureFallback({
            model,
            provider,
            fallbackIndex: i,
            authType,
            tenantProviderId: credentials.tenantProviderId,
            keyLabel: providerKeyLabel,
            presentation: presentCredentialFailure(
              credentials.reason,
              provider,
              credentialDashboardUrl ?? 'the dashboard',
            ),
            startProviderAttempt,
          }),
        );
        continue;
      }
      // resolveRouteCredentials always reports the row it selected, which may
      // differ from the pin when the pin matched nothing.
      providerKeyLabel = credentials.keyLabel;
      const tenantProviderId = credentials.tenantProviderId;

      // key= is load-bearing, not decoration: several slots in a chain routinely
      // share model+provider+auth_type and differ only by which account they
      // draw on. Without the label a second-account fallback is indistinguishable
      // from a pointless self-retry, and the only way to tell them apart is a
      // separate /routing/resolve call after the incident is over.
      this.logger.log(
        `Fallback ${i}: trying model=${model} provider=${provider} auth_type=${authType} ` +
          `key=${providerKeyLabel ?? '-'} (primary=${primaryModel})`,
      );

      const forward = await this.tryForwardToProvider({
        provider,
        apiKey: credentials.apiKey,
        model,
        body,
        resolveChatBody,
        stream,
        sessionKey,
        providerCacheKey,
        signal,
        agentId,
        tenantId,
        rawApiKey: credentials.rawApiKey,
        providerKeyLabel,
        authType,
        apiMode,
        resourceUrl: credentials.resourceUrl,
        providerRegion: credentials.providerRegion,
        signatureLookup,
        thinkingLookup,
        paramMergeContext,
        tenantProviderId,
        startProviderAttempt,
        inboundHeaders,
      });

      if (forward.response.ok) {
        return {
          success: {
            forward,
            model,
            provider,
            fallbackIndex: i,
            authType,
            // Label of the connection row that served the attempt — stamped
            // alongside its tenant_provider_id so the pair always matches.
            keyLabel: providerKeyLabel,
            tenantProviderId,
          },
          failures,
        };
      }

      const errorBody = await forward.response.text();
      await forward.attempt?.finishRecording?.(recordingResponseFromText(errorBody));
      failures.push({
        model,
        provider,
        fallbackIndex: i,
        status: forward.response.status,
        errorBody,
        authType,
        tenantProviderId,
        // Selected-row label (credentials.keyLabel already folded in above),
        // so this row's label and tenant_provider_id name the same connection.
        keyLabel: providerKeyLabel,
        attempt: forward.attempt,
        providerCallStarted: forward.providerCallStarted,
      });

      const existing = failedAuthByProvider.get(provider.toLowerCase());
      const updated = new Set(existing);
      updated.add(authType);
      failedAuthByProvider.set(provider.toLowerCase(), updated);

      if (!shouldTriggerFallback(forward.response.status)) break;
    }
    return { success: null, failures };
  }

  private routeCredentialDeps(): RouteCredentialDeps {
    return {
      providerKeyService: this.providerKeyService,
      oauth: {
        openaiOauth: this.openaiOauth,
        minimaxOauth: this.minimaxOauth,
        anthropicOauth: this.anthropicOauth,
        geminiOauth: this.geminiOauth,
        kiroOauth: this.kiroOauth,
        xaiOauth: this.xaiOauth,
      },
    };
  }

  async tryForwardToProvider(opts: ForwardProviderOptions): Promise<ForwardResult> {
    try {
      const forward = await this.forwardToProvider(opts);
      const result = await this.retryOAuthSubscriptionAfterRejectedToken(opts, forward);
      await this.noteCredentialBillingHealth(opts, result.response);
      return result;
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (!isTransportError(error)) throw error;

      const failureResponse = buildTransportErrorResponse(error);
      const message = describeTransportError(error);
      this.logger.warn(
        `Provider transport failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${message}`,
      );

      return {
        response: failureResponse,
        attempt: attemptFromError(error),
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  /**
   * Anthropic answers a spent subscription with a 400 on every call, so a
   * tenant whose default connection is exhausted otherwise replays the same
   * doomed forward forever. Record the verdict against the connection that
   * served the attempt; key selection reads it to prefer a sibling.
   */
  private async noteCredentialBillingHealth(
    opts: ForwardProviderOptions,
    response: Response,
  ): Promise<void> {
    if (!this.credentialHealth || !opts.tenantId || !opts.providerKeyLabel) return;
    const scope = {
      tenantId: opts.tenantId,
      provider: opts.provider,
      authType: opts.authType as AuthType | undefined,
      label: opts.providerKeyLabel,
    };
    if (response.ok) {
      this.credentialHealth.markHealthy(scope);
      return;
    }
    if (response.status !== 400) return;
    try {
      const errorBody = await response.clone().text();
      if (isAnthropicExtraUsageError({ provider: opts.provider, httpStatus: 400, errorBody })) {
        this.credentialHealth.markExhausted(scope, 'subscription extra usage is spent');
      }
    } catch {
      // Best effort — an unreadable body just leaves health unchanged.
    }
  }

  /** Re-send a healed body without rebuilding the already-resolved provider request. */
  async retryWireBody(
    forward: ForwardResult,
    healedBody: Record<string, unknown>,
    opts?: Pick<
      ForwardProviderOptions,
      | 'provider'
      | 'model'
      | 'authType'
      | 'tenantProviderId'
      | 'providerKeyLabel'
      | 'startProviderAttempt'
      | 'signal'
    >,
  ): Promise<ForwardResult> {
    if (!forward.retryWireBody) {
      throw new Error('Provider forward does not support wire-body retry');
    }
    if (!opts) return forward.retryWireBody(healedBody);
    const attempt = opts.startProviderAttempt?.({
      provider: opts.provider,
      model: opts.model,
      authType: opts.authType,
      tenantProviderId: opts.tenantProviderId,
      keyLabel: opts.providerKeyLabel,
    });
    try {
      const retried = await forward.retryWireBody(healedBody, attempt);
      if (attempt) attempt.completedAtMs = Date.now();
      return { ...retried, attempt, providerCallStarted: true };
    } catch (error) {
      if (attempt) attempt.completedAtMs = Date.now();
      if (attempt && error instanceof Error) {
        (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] = attempt;
      }
      if (opts.signal?.aborted || !isTransportError(error)) throw error;

      const failureResponse = buildTransportErrorResponse(error);
      const message = describeTransportError(error);
      this.logger.warn(
        `Provider transport failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${message}`,
      );
      return {
        response: failureResponse,
        attempt,
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  private async retryOAuthSubscriptionAfterRejectedToken(
    opts: ForwardProviderOptions,
    forward: ForwardResult,
  ): Promise<ForwardResult> {
    if (
      opts.authType !== 'subscription' ||
      forward.response.status !== 401 ||
      !opts.rawApiKey ||
      !opts.agentId ||
      !opts.tenantId
    ) {
      return forward;
    }

    const refreshed = await refreshRejectedOAuthCredential(
      opts.provider,
      opts.rawApiKey,
      opts.agentId,
      opts.tenantId,
      opts.providerKeyLabel,
      {
        openaiOauth: this.openaiOauth,
        minimaxOauth: this.minimaxOauth,
        anthropicOauth: this.anthropicOauth,
        geminiOauth: this.geminiOauth,
        kiroOauth: this.kiroOauth,
        xaiOauth: this.xaiOauth,
      },
    );
    if (!refreshed?.apiKey || refreshed.apiKey === opts.apiKey) return forward;

    this.logger.log(
      `OAuth token rejected upstream; refreshed provider=${opts.provider} agent=${opts.agentId}`,
    );
    const rejectedBody = await forward.response
      .clone()
      .text()
      .catch(() => 'OAuth token rejected');
    await forward.attempt?.finishRecording?.(recordingResponseFromText(rejectedBody));
    await forward.attempt?.completeFailure?.({
      status: forward.response.status,
      errorBody: rejectedBody,
      superseded: true,
    });
    const retryOpts = {
      ...opts,
      apiKey: refreshed.apiKey,
      resourceUrl: refreshed.resourceUrl ?? opts.resourceUrl,
    };
    try {
      return await this.forwardToProvider(retryOpts);
    } catch (error) {
      if (opts.signal?.aborted || !isTransportError(error)) throw error;
      return {
        response: buildTransportErrorResponse(error),
        attempt: attemptFromError(error),
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  private async forwardToProvider(opts: ForwardProviderOptions): Promise<ForwardResult> {
    const {
      provider,
      stream,
      signal,
      authType,
      resourceUrl,
      providerRegion,
      signatureLookup,
      thinkingLookup,
    } = opts;
    // Per-attempt merge: ask the model-params service for this iteration's
    // (provider, auth_type, model) config. Storage is model-scoped on the
    // new agent_model_params table, so a primary OpenAI route with a
    // DeepSeek fallback no longer needs the old per-provider filter —
    // OpenAI's lookup returns null, DeepSeek's returns its own row.
    let body = await this.applyParamMerge(
      opts.body,
      opts.paramMergeContext,
      provider,
      authType,
      opts.model,
    );
    // Manifest owns the provider-facing identity outright: nothing from the
    // inbound caller rides along. Forwarding a harness's user-agent and
    // x-stainless-* set let an OpenAI-SDK caller rewrite the Claude Code
    // identity on an Anthropic subscription request.
    const extraHeaders = buildProviderExtraHeaders(provider, opts.providerCacheKey);

    // Copilot: exchange the stored GitHub OAuth token for a short-lived API token
    let effectiveKey = opts.apiKey;
    if (provider.toLowerCase() === 'copilot') {
      effectiveKey = await this.copilotToken.getCopilotToken(opts.apiKey);
    }

    // Custom providers store their endpoint on a DB row; fetch it so the shared
    // resolver can build the override. (Kept in the caller to keep the resolver
    // synchronous + DB-free.)
    // Fail closed: TypeORM strips an `undefined` where-value, so without the
    // explicit tenantId guard a missing tenantId would silently degrade to an
    // unscoped lookup by id alone. A real custom-provider forward always carries
    // the caller's tenantId; if it's absent we skip the lookup rather than read a
    // row that could belong to another tenant.
    const customProvider =
      CustomProviderService.isCustom(provider) && opts.tenantId
        ? await this.customProviderRepo.findOne({
            where: { id: CustomProviderService.extractId(provider), tenant_id: opts.tenantId },
          })
        : null;
    const { customEndpoint, forwardModel } = resolveForwardEndpoint({
      provider,
      authType,
      model: opts.model,
      providerRegion,
      resourceUrl,
      customProvider,
      logger: this.logger,
    });

    const reasoningEndpointKey =
      customEndpoint && customEndpoint.format !== 'openai'
        ? null
        : customEndpoint
          ? 'custom'
          : resolveEndpointKey(provider);
    let resolvedChatBody: Promise<Record<string, unknown>> | undefined;
    const resolveChatBody = opts.resolveChatBody
      ? () => {
          resolvedChatBody ??= (async () => {
            let resolved = await opts.resolveChatBody!();
            resolved = await this.applyParamMerge(
              resolved,
              opts.paramMergeContext,
              provider,
              authType,
              opts.model,
            );
            resolved = await this.reasoningCache.prepareRequest(
              resolved,
              opts.sessionKey,
              reasoningEndpointKey,
              forwardModel,
            );
            return resolved;
          })();
          return resolvedChatBody;
        }
      : undefined;
    body = await this.reasoningCache.prepareRequest(
      body,
      opts.sessionKey,
      reasoningEndpointKey,
      forwardModel,
    );

    // For Gemini OAuth, the OAuth blob's `u` field is the
    // CodeAssist project id (not a URL). It must be forwarded so the
    // CodeAssist envelope wrap can include it.
    const providerResource =
      authType === 'subscription' && provider.toLowerCase() === 'gemini' ? resourceUrl : undefined;

    const attempt = opts.startProviderAttempt?.({
      provider,
      model: opts.model,
      authType,
      tenantProviderId: opts.tenantProviderId,
      keyLabel: opts.providerKeyLabel,
    });
    try {
      const forward = await this.providerClient.forward({
        provider,
        apiKey: effectiveKey,
        model: forwardModel,
        body,
        resolveChatBody,
        stream,
        signal,
        extraHeaders,
        customEndpoint,
        authType,
        apiMode: opts.apiMode,
        sessionKey: opts.sessionKey,
        providerCacheKey: opts.providerCacheKey,
        signatureLookup,
        thinkingLookup,
        ...(thinkingLookup
          ? {
              thinkingRouteContext: {
                provider,
                authType,
                model: opts.model,
              },
            }
          : {}),
        providerResource,
        attempt,
      });
      if (attempt) attempt.completedAtMs = Date.now();
      return { ...forward, attempt, providerCallStarted: true };
    } catch (error) {
      if (attempt) attempt.completedAtMs = Date.now();
      if (attempt && error instanceof Error) {
        (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] = attempt;
      }
      throw error;
    }
  }
}

export function normalizeProviderModel(provider: string, model: string): string {
  return provider.toLowerCase() === 'anthropic' ? normalizeAnthropicShortModelId(model) : model;
}
