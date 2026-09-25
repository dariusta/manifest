import {
  GOOGLE_NATIVE_BASE_URL,
  UPLOAD_SESSION_PREFIX,
  buildGoogleNativeAuthHeaders,
  callerFacingOrigin,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isEventStream,
  rewriteUploadUrl,
} from '../google-native-wire';

describe('google-native-wire', () => {
  it('points at the public Gemini host', () => {
    expect(GOOGLE_NATIVE_BASE_URL).toBe('https://generativelanguage.googleapis.com');
  });

  describe('buildGoogleNativeAuthHeaders', () => {
    it('sends an API key in x-goog-api-key', () => {
      expect(
        buildGoogleNativeAuthHeaders({ authType: 'api_key', credential: 'AIza-test' }),
      ).toEqual({ 'x-goog-api-key': 'AIza-test' });
    });

    it('sends a subscription token as a bearer with its quota project', () => {
      expect(
        buildGoogleNativeAuthHeaders({
          authType: 'subscription',
          credential: 'ya29.token',
          quotaProject: 'my-cca-project',
        }),
      ).toEqual({
        Authorization: 'Bearer ya29.token',
        'x-goog-user-project': 'my-cca-project',
      });
    });

    it('omits the quota project when the OAuth blob carried none', () => {
      expect(
        buildGoogleNativeAuthHeaders({ authType: 'subscription', credential: 'ya29.token' }),
      ).toEqual({ Authorization: 'Bearer ya29.token' });
    });
  });

  describe('forwardableRequestHeaders', () => {
    it('relays the whole resumable-upload protocol', () => {
      expect(
        forwardableRequestHeaders({
          'content-type': 'application/json',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-offset': '0',
          'x-goog-upload-header-content-length': '1645059',
          'x-goog-upload-header-content-type': 'video/mp4',
        }),
      ).toEqual({
        'content-type': 'application/json',
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-offset': '0',
        'x-goog-upload-header-content-length': '1645059',
        'x-goog-upload-header-content-type': 'video/mp4',
      });
    });

    it('never leaks the caller credential, host or length upstream', () => {
      const out = forwardableRequestHeaders({
        Authorization: 'Bearer mnfst_secret',
        'x-goog-api-key': 'caller-supplied',
        host: 'manifest.example.com',
        'content-length': '17',
        cookie: 'session=abc',
        accept: '*/*',
      });
      expect(out).toEqual({ accept: '*/*' });
    });

    it('lower-cases names and joins repeated values', () => {
      expect(forwardableRequestHeaders({ 'Content-Type': ['a/b', 'c/d'] })).toEqual({
        'content-type': 'a/b, c/d',
      });
    });

    it('drops headers Express reports as undefined', () => {
      expect(forwardableRequestHeaders({ accept: undefined })).toEqual({});
    });
  });

  describe('forwardableResponseHeaders', () => {
    it('relays upload status but not the upload URL', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-goog-upload-status': 'active',
        'x-goog-upload-chunk-granularity': '262144',
        'x-goog-upload-size-received': '1024',
        'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/secret',
        'set-cookie': 'nope=1',
      });
      expect(forwardableResponseHeaders(headers)).toEqual({
        'content-type': 'application/json',
        'x-goog-upload-status': 'active',
        'x-goog-upload-chunk-granularity': '262144',
        'x-goog-upload-size-received': '1024',
      });
    });
  });

  describe('callerFacingOrigin', () => {
    const req = (headers: Record<string, string | string[] | undefined>, host?: string) => ({
      protocol: 'http',
      headers,
      get: () => host,
    });

    it('prefers the forwarded proto and host behind a reverse proxy', () => {
      expect(
        callerFacingOrigin(
          req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'manifest.example.com' }),
        ),
      ).toBe('https://manifest.example.com');
    });

    it('uses the first hop of a multi-proxy forwarded chain', () => {
      expect(
        callerFacingOrigin(
          req({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'a.example.com, b' }),
        ),
      ).toBe('https://a.example.com');
    });

    it('takes the first value when Express reports an array', () => {
      expect(
        callerFacingOrigin(req({ 'x-forwarded-proto': ['https'], 'x-forwarded-host': ['h.dev'] })),
      ).toBe('https://h.dev');
    });

    it('falls back to the request protocol and Host header', () => {
      expect(callerFacingOrigin(req({}, 'localhost:3001'))).toBe('http://localhost:3001');
    });

    it('falls back to localhost when there is no Host at all', () => {
      expect(callerFacingOrigin(req({}))).toBe('http://localhost');
    });

    it('ignores an empty forwarded header rather than building "://host"', () => {
      expect(callerFacingOrigin(req({ 'x-forwarded-proto': '' }, 'h:1'))).toBe('http://h:1');
    });
  });

  describe('rewriteUploadUrl', () => {
    it('points the SDK back through Manifest, not at Google', () => {
      expect(rewriteUploadUrl('https://manifest.example.com', 'ticket-1')).toBe(
        'https://manifest.example.com/upload/v1beta/files/session/ticket-1',
      );
    });

    it('agrees with the raw-body mount path in main.ts', () => {
      expect(
        rewriteUploadUrl('https://h', 't').startsWith(`https://h${UPLOAD_SESSION_PREFIX}`),
      ).toBe(true);
    });
  });

  describe('isEventStream', () => {
    it.each([
      ['text/event-stream', true],
      ['text/event-stream; charset=utf-8', true],
      ['TEXT/EVENT-STREAM', true],
      ['application/json', false],
      [null, false],
    ])('%s -> %s', (contentType, expected) => {
      expect(isEventStream(contentType as string | null)).toBe(expected);
    });
  });
});
