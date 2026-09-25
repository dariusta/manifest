jest.mock('../../proxy/route-credentials', () => ({
  ...jest.requireActual('../../proxy/route-credentials'),
  resolveRouteCredentials: jest.fn(),
}));

import { ConfigService } from '@nestjs/config';
import { GoogleNativeService } from '../google-native.service';
import { ManifestError } from '../../../common/errors/manifest-error';
import {
  resolveRouteCredentials,
  type ResolvedRouteCredentials,
} from '../../proxy/route-credentials';
import type { ProviderKeyService } from '../../routing-core/provider-key.service';
import type { OpenaiOauthService } from '../../oauth/openai/openai-oauth.service';
import type { MinimaxOauthService } from '../../oauth/minimax/minimax-oauth.service';
import type { AnthropicOauthService } from '../../oauth/anthropic/anthropic-oauth.service';
import type { GeminiOauthService } from '../../oauth/gemini/gemini-oauth.service';
import type { KiroOauthService } from '../../oauth/kiro/kiro-oauth.service';
import type { XaiOauthService } from '../../oauth/xai/xai-oauth.service';

const mockedResolve = resolveRouteCredentials as jest.MockedFunction<
  typeof resolveRouteCredentials
>;

const ok = (over: Partial<Extract<ResolvedRouteCredentials, { ok: true }>> = {}) =>
  ({
    ok: true,
    apiKey: 'resolved-key',
    rawApiKey: 'raw-key',
    tenantProviderId: 'tp-1',
    keyLabel: 'Default',
    ...over,
  }) as ResolvedRouteCredentials;

const notOk = (reason: 'no_provider_key' | 'subscription_credentials_unusable') =>
  ({ ok: false, reason, tenantProviderId: null }) as ResolvedRouteCredentials;

describe('GoogleNativeService', () => {
  let service: GoogleNativeService;
  let config: ConfigService;
  const providerKeyService = {
    selectProviderKey: jest.fn(),
    getProviderApiKey: jest.fn(),
  } as unknown as ProviderKeyService;

  beforeEach(() => {
    jest.clearAllMocks();
    config = new ConfigService({ app: { betterAuthUrl: 'https://dash.example.com' } });
    service = new GoogleNativeService(
      config,
      providerKeyService,
      {} as OpenaiOauthService,
      {} as MinimaxOauthService,
      {} as AnthropicOauthService,
      {} as GeminiOauthService,
      {} as KiroOauthService,
      {} as XaiOauthService,
    );
  });

  describe('resolveAuth', () => {
    it('prefers an API key and never asks for a subscription', async () => {
      mockedResolve.mockResolvedValueOnce(ok({ apiKey: 'AIza-live' }));

      await expect(service.resolveAuth('agent-1', 'tenant-1')).resolves.toEqual({
        authType: 'api_key',
        credential: 'AIza-live',
      });
      expect(mockedResolve).toHaveBeenCalledTimes(1);
      expect(mockedResolve).toHaveBeenCalledWith(expect.anything(), {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        provider: 'gemini',
        authType: 'api_key',
      });
    });

    it('passes the OAuth project id through as the quota project', async () => {
      mockedResolve
        .mockResolvedValueOnce(notOk('no_provider_key'))
        .mockResolvedValueOnce(ok({ apiKey: 'ya29.token', resourceUrl: 'cca-project' }));

      await expect(service.resolveAuth('agent-1', 'tenant-1')).resolves.toEqual({
        authType: 'subscription',
        credential: 'ya29.token',
        quotaProject: 'cca-project',
      });
    });

    it('leaves the quota project undefined when the blob carried none', async () => {
      mockedResolve
        .mockResolvedValueOnce(notOk('no_provider_key'))
        .mockResolvedValueOnce(ok({ apiKey: 'ya29.token' }));

      await expect(service.resolveAuth('agent-1', 'tenant-1')).resolves.toEqual({
        authType: 'subscription',
        credential: 'ya29.token',
        quotaProject: undefined,
      });
    });

    it('raises M100 with a dashboard link when nothing is connected', async () => {
      mockedResolve.mockResolvedValue(notOk('no_provider_key'));

      const err = await service.resolveAuth('agent-1', 'tenant-1', 'demo-agent').catch((e) => e);
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).code).toBe('M100');
      expect((err as ManifestError).getStatus()).toBe(401);
      expect((err as ManifestError).message).toContain(
        'https://dash.example.com/agents/demo-agent/routing',
      );
    });

    it('keeps the more informative M102 over a bare "no key"', async () => {
      // api_key misses entirely; the subscription exists but cannot be refreshed.
      mockedResolve
        .mockResolvedValueOnce(notOk('no_provider_key'))
        .mockResolvedValueOnce(notOk('subscription_credentials_unusable'));

      const err = await service.resolveAuth('agent-1', 'tenant-1').catch((e) => e);
      expect((err as ManifestError).code).toBe('M102');
    });
  });

  describe('forward', () => {
    const fetchMock = jest.fn();
    const auth = { authType: 'api_key' as const, credential: 'AIza-live' };

    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    it('resolves a bare path against the Google host and attaches auth', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'a/b' } }));

      const out = await service.forward({
        method: 'GET',
        url: '/v1beta/files',
        auth,
        headers: { accept: 'application/json', authorization: 'Bearer mnfst_secret' },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/files',
        {
          method: 'GET',
          headers: { accept: 'application/json', 'x-goog-api-key': 'AIza-live' },
        },
      );
      expect(out.status).toBe(200);
      expect(out.contentType).toBe('a/b');
    });

    it('uses an absolute URL as given (Google’s own upload URL)', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const out = await service.forward({
        method: 'POST',
        url: 'https://generativelanguage.googleapis.com/upload/v1beta/files/xyz',
        auth,
        headers: {},
        body: 'raw',
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://generativelanguage.googleapis.com/upload/v1beta/files/xyz',
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: 'raw' });
      expect(out.body).toBeNull();
      expect(out.contentType).toBeNull();
    });

    it('sends a Buffer body as a zero-copy view over the same memory', async () => {
      fetchMock.mockResolvedValue(new Response('{}'));
      const buf = Buffer.from('media-bytes');

      await service.forward({ method: 'POST', url: '/upload', auth, headers: {}, body: buf });

      const sent = (fetchMock.mock.calls[0]?.[1] as { body: Uint8Array }).body;
      expect(sent).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(sent).toString()).toBe('media-bytes');
      // Same backing store, not a copy — the point of the narrowing cast.
      expect(sent.buffer).toBe(buf.buffer);
    });

    it('turns a transport failure into M500/502, not a relayed provider status', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      const err = await service
        .forward({ method: 'GET', url: '/v1beta/files', auth, headers: {} })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).code).toBe('M500');
      expect((err as ManifestError).getStatus()).toBe(502);
    });
  });

  describe('upload sessions', () => {
    it('round-trips a ticket for the tenant that created it', () => {
      service.rememberUploadSession('t-1', { uploadUrl: 'https://g/u/1', tenantId: 'tenant-1' });

      expect(service.takeUploadSession('t-1', 'tenant-1')).toEqual({
        uploadUrl: 'https://g/u/1',
        tenantId: 'tenant-1',
      });
    });

    it('reads a mismatched tenant as "no such ticket"', () => {
      service.rememberUploadSession('t-1', { uploadUrl: 'https://g/u/1', tenantId: 'tenant-1' });

      expect(service.takeUploadSession('t-1', 'other-tenant')).toBeUndefined();
    });

    it('returns undefined for a ticket that was never issued', () => {
      expect(service.takeUploadSession('nope', 'tenant-1')).toBeUndefined();
    });

    it('forgets a ticket once the upload finalizes', () => {
      service.rememberUploadSession('t-1', { uploadUrl: 'https://g/u/1', tenantId: 'tenant-1' });
      service.forgetUploadSession('t-1');

      expect(service.takeUploadSession('t-1', 'tenant-1')).toBeUndefined();
    });
  });
});
