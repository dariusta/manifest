import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { OpenaiOauthService } from '../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../oauth/xai/xai-oauth.service';
import {
  credentialFailureCode,
  resolveRouteCredentials,
  CREDENTIAL_FAILURE_HTTP_STATUS,
  type CredentialFailureReason,
  type RouteCredentialDeps,
} from '../proxy/route-credentials';
import { getDashboardUrl } from '../proxy/proxy-friendly-response';
import { ManifestError } from '../../common/errors/manifest-error';
import { TtlCache } from '../../common/utils/ttl-cache';
import {
  GOOGLE_NATIVE_BASE_URL,
  buildGoogleNativeAuthHeaders,
  forwardableRequestHeaders,
  type GoogleNativeAuth,
} from './google-native-wire';

/**
 * Auth routes tried in order when the caller did not pin one.
 *
 * A real Gemini API key is preferred because it is the credential Google's own
 * docs assume for both surfaces. The Antigravity subscription token works too
 * (its scope set includes `cloud-platform`), but it needs a quota project and
 * is refreshed on a timer, so it is the second choice rather than the first.
 */
const AUTH_PREFERENCE = ['api_key', 'subscription'] as const;

/**
 * Upload tickets are short-lived by nature: the SDK receives one and posts the
 * bytes immediately. An hour is generous for a slow large upload while keeping
 * a dead session from pinning Google's URL in memory indefinitely.
 */
const UPLOAD_TICKET_TTL_MS = 60 * 60 * 1000;
const UPLOAD_TICKET_MAX = 5_000;

/** One resumable upload in flight, keyed by the opaque ticket we handed out. */
export interface UploadSession {
  /** Google's own upload URL — never shown to the caller. */
  uploadUrl: string;
  /** Tenant that started the handshake; a ticket is not valid for anyone else. */
  tenantId: string;
}

export interface GoogleNativeForward {
  status: number;
  headers: Headers;
  /** Null for 204s and for a HEAD-like empty body. */
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
}

@Injectable()
export class GoogleNativeService {
  private readonly logger = new Logger(GoogleNativeService.name);

  /**
   * Ticket → Google upload URL. In-memory on purpose: a resumable upload is
   * pinned to the replica that started it anyway (Google's URL embeds an
   * upload id its own backend tracks), so persisting the mapping would invite
   * a second replica to resume a session it cannot actually continue.
   */
  private readonly uploadSessions = new TtlCache<string, UploadSession>({
    maxSize: UPLOAD_TICKET_MAX,
    ttlMs: UPLOAD_TICKET_TTL_MS,
  });

  constructor(
    private readonly config: ConfigService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
  ) {}

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

  /**
   * The caller's Google credential, preferring an API key over a subscription.
   *
   * Raises the same M100/M102 the router raises rather than relaying an
   * anonymous request: without a credential Google answers 403 "unregistered
   * callers", which reads as a Manifest bug to whoever sees it. Naming the
   * missing connection is the whole point of the code.
   */
  async resolveAuth(
    agentId: string,
    tenantId: string,
    agentName?: string,
  ): Promise<GoogleNativeAuth> {
    // Keep the most informative failure. "No key at all" (M100) is the weakest
    // reason there is — if a subscription *is* connected but could not be
    // refreshed, M102 tells the caller to reconnect OAuth instead of sending
    // them off to add a key they already have.
    let reason: CredentialFailureReason = 'no_provider_key';
    for (const authType of AUTH_PREFERENCE) {
      const resolved = await resolveRouteCredentials(this.routeCredentialDeps(), {
        agentId,
        tenantId,
        provider: 'gemini',
        authType,
      });
      if (!resolved.ok) {
        if (resolved.reason !== 'no_provider_key') reason = resolved.reason;
        continue;
      }
      if (authType === 'api_key') return { authType, credential: resolved.apiKey };
      return {
        authType,
        credential: resolved.apiKey,
        // Antigravity's OAuth blob carries the Cloud Code project id in `u`,
        // surfaced as `resourceUrl`. It is the quota project for this token.
        quotaProject: resolved.resourceUrl,
      };
    }
    // ManifestError (not a bare HttpException) so the code is carried as data
    // rather than inferred from message text, and reuses the router's own
    // code/status mapping so a Gemini-native caller reads the same M100/M102.
    throw new ManifestError(credentialFailureCode(reason), CREDENTIAL_FAILURE_HTTP_STATUS, {
      provider: 'gemini',
      dashboardUrl: getDashboardUrl(this.config, agentName, 'routing'),
    });
  }

  /** Forwards one request to `generativelanguage.googleapis.com` unchanged. */
  async forward(args: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
    /** Absolute URL, or a `/v1beta/...` path resolved against the Google host. */
    url: string;
    auth: GoogleNativeAuth;
    headers: Record<string, string | string[] | undefined>;
    body?: Buffer | string | undefined;
  }): Promise<GoogleNativeForward> {
    const url = args.url.startsWith('http') ? args.url : `${GOOGLE_NATIVE_BASE_URL}${args.url}`;
    const headers: Record<string, string> = {
      ...forwardableRequestHeaders(args.headers),
      ...buildGoogleNativeAuthHeaders(args.auth),
    };
    // A Node Buffer does not satisfy `BodyInit`: the ambient one is the DOM
    // type, whose `BufferSource` pins the view to `ArrayBufferView<ArrayBuffer>`,
    // while a Buffer's backing store is typed `ArrayBufferLike` because it
    // *could* be a SharedArrayBuffer. It never is for a body-parser buffer, and
    // undici accepts any ArrayBufferView at runtime — so narrow the type rather
    // than re-allocate, which would double peak memory on a large upload.
    const body =
      args.body === undefined
        ? undefined
        : Buffer.isBuffer(args.body)
          ? (new Uint8Array(
              args.body.buffer,
              args.body.byteOffset,
              args.body.byteLength,
            ) as unknown as BodyInit)
          : args.body;
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: args.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (err) {
      // A transport failure here is Manifest's problem to report, not a
      // provider status to relay — there is no provider response to relay.
      this.logger.warn(`Gemini-native forward to ${url} failed: ${String(err)}`);
      throw new ManifestError('M500', 502, { error: String(err) });
    }
    return {
      status: upstream.status,
      headers: upstream.headers,
      body: upstream.body,
      contentType: upstream.headers.get('content-type'),
    };
  }

  /** Remembers Google's upload URL behind an opaque ticket. */
  rememberUploadSession(ticket: string, session: UploadSession): void {
    this.uploadSessions.set(ticket, session);
  }

  /**
   * Looks a ticket up **for one tenant**. A ticket is a bearer-ish capability
   * that reaches a Google upload session, so a mismatched tenant must read as
   * "no such ticket" rather than as a permission error that confirms it exists.
   */
  takeUploadSession(ticket: string, tenantId: string): UploadSession | undefined {
    const session = this.uploadSessions.get(ticket);
    if (!session || session.tenantId !== tenantId) return undefined;
    return session;
  }

  /** Drops a ticket once its upload is finalized. */
  forgetUploadSession(ticket: string): void {
    this.uploadSessions.delete(ticket);
  }
}
