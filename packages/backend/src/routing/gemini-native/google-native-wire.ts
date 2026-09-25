/**
 * Wire details for the two Gemini-native surfaces Manifest passes through
 * verbatim: the **Files API** and **agentic mode** (`/v1beta/interactions`).
 *
 * Neither surface is routable. There is no model to score, no tier to pick and
 * no fallback chain — a file handle and an interaction id are *upstream state*,
 * so the only correct thing Manifest can do is forward to the same Google
 * project that will later be asked to read them. Everything here is therefore
 * about faithfully relaying one request, not about choosing where it goes.
 *
 * Kept separate from `provider-endpoints.ts` on purpose: that registry
 * describes *completion* endpoints and every entry there is reachable by the
 * router. Adding a non-routable endpoint to it would make `format`/`buildPath`
 * meaningless for that row.
 */

/** Gemini's public API host. Files and interactions both live here. */
export const GOOGLE_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * How the caller's Google credential authenticates against the host.
 *
 * An API key goes in `x-goog-api-key`. A subscription (Antigravity OAuth)
 * carries a bearer token whose scope set already includes `cloud-platform`,
 * but a bearer token has no project attached the way an API key does — so the
 * quota project has to ride along in `x-goog-user-project` or Google answers
 * 403 with a "project not specified" `SERVICE_DISABLED`.
 */
export type GoogleNativeAuth =
  | { authType: 'api_key'; credential: string }
  | { authType: 'subscription'; credential: string; quotaProject?: string | undefined };

/**
 * Request headers worth relaying. Everything else is either hop-by-hop, a
 * Manifest credential that must not reach Google, or a length/host value that
 * would describe the wrong request after re-framing.
 *
 * `x-goog-upload-*` is the whole resumable-upload protocol (`start`,
 * `upload, finalize`, byte offsets), so dropping it would silently turn a
 * resumable upload into a malformed single-shot one.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'x-goog-upload-protocol',
  'x-goog-upload-command',
  'x-goog-upload-offset',
  'x-goog-upload-header-content-length',
  'x-goog-upload-header-content-type',
]);

/**
 * Response headers worth relaying back. `x-goog-upload-url` is deliberately
 * absent — it is rewritten rather than copied (see `rewriteUploadUrl`), and
 * copying it too would hand the caller Google's endpoint alongside ours.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'x-goog-upload-status',
  'x-goog-upload-chunk-granularity',
  'x-goog-upload-size-received',
]);

/** Auth headers for one upstream call. */
export function buildGoogleNativeAuthHeaders(auth: GoogleNativeAuth): Record<string, string> {
  if (auth.authType === 'api_key') return { 'x-goog-api-key': auth.credential };
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.credential}` };
  if (auth.quotaProject) headers['x-goog-user-project'] = auth.quotaProject;
  return headers;
}

/** The relayable subset of the caller's request headers, lower-cased. */
export function forwardableRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** The relayable subset of Google's response headers. */
export function forwardableResponseHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.forEach((value, name) => {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  });
  return out;
}

/**
 * The public origin this Manifest is reachable at, as the caller addressed it.
 *
 * Needed because the resumable upload handshake answers with an **absolute**
 * URL the SDK then POSTs bytes to. A relative path is not an option, and
 * hardcoding a configured base URL would break every deployment that is
 * reached by more than one hostname.
 */
export function callerFacingOrigin(req: {
  protocol: string;
  headers: Record<string, string | string[] | undefined>;
  get(name: string): string | undefined;
}): string {
  const header = (name: string): string | undefined => {
    const raw = req.headers[name];
    const first = Array.isArray(raw) ? raw[0] : raw;
    // A proxy chain sends `x-forwarded-proto: https, http`; the client-facing
    // hop is the first one.
    return first?.split(',')[0]?.trim() || undefined;
  };
  const proto = header('x-forwarded-proto') ?? req.protocol;
  const host = header('x-forwarded-host') ?? req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}

/** Where the SDK should send upload bytes so they pass back through Manifest. */
export function rewriteUploadUrl(origin: string, ticket: string): string {
  return `${origin}/upload/v1beta/files/session/${ticket}`;
}

/**
 * Google answers a *streaming* interaction as SSE. It sends **no `[DONE]`
 * sentinel** — the stream just ends — so a relay must treat upstream EOF as
 * the terminator rather than waiting for a marker that never arrives.
 */
export function isEventStream(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('text/event-stream');
}

/**
 * Express mount path for the resumable-upload byte leg.
 *
 * Shared with `main.ts` rather than duplicated: the raw-body parser and the
 * route have to agree exactly, and a silent divergence would send the media
 * through `express.json()` — where it fails on the first non-UTF8 byte.
 */
export const UPLOAD_SESSION_PREFIX = '/upload/v1beta/files/session';
