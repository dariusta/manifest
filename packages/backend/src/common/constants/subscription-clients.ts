import { createHash } from 'node:crypto';

/**
 * Client identification strings sent to subscription backends that gate model
 * lists or requests by client version. Lifted into one place so bumping a
 * version when an upstream releases a new model is a single edit.
 *
 * Codex (`https://chatgpt.com/backend-api/codex/...`): the `client_version`
 * URL param is enforced — older versions silently receive an older model
 * subset. Bump `CODEX_CLI_VERSION` to track the current `openai/codex` CLI
 * release. The user-agent string is not enforced, so it stays synthetic.
 *
 * Copilot (`https://api.githubcopilot.com/...`): GitHub validates the
 * `Editor-Version` and `Editor-Plugin-Version` headers; both are bumped
 * together when GitHub deprecates an older pair.
 */

export const CODEX_CLI_VERSION = '0.128.0';
export const CODEX_CLI_ORIGINATOR = 'codex_cli_rs';
export const CODEX_CLI_USER_AGENT = 'codex_cli_rs/0.0.0 (Unknown 0; unknown) unknown';

// Anthropic gates Fable 5.1 (`claude-fable-5-1`) behind Claude Code
// 2.1.251+. Identify as the current latest CLI so subscription harnesses
// are not rejected with claude_code_version_too_old.
export const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.258 (external, sdk-cli)';
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.112.1';
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = 'v26.3.0';
export const CLAUDE_CODE_BETA_FLAGS = [
  'claude-code-20250219',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
].join(',');

/** Compatibility identity owned by Manifest for Anthropic subscription calls. */
export const CLAUDE_CODE_PROVIDER_OWNED_HEADERS = Object.freeze([
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'user-agent',
  'x-app',
  'x-forwarded-server',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
]);

export function claudeCodeForwardedServerId(
  seed = process.env.BETTER_AUTH_URL ??
    process.env.MANIFEST_PUBLIC_URL ??
    process.env.HOSTNAME ??
    'manifest',
): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

export function claudeCodeStainlessArch(arch = process.arch): string {
  switch (arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'x64';
    default:
      return `Other:${arch}`;
  }
}

export function claudeCodeStainlessOs(platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'MacOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    case 'freebsd':
      return 'FreeBSD';
    default:
      return `Other:${platform}`;
  }
}

export const buildClaudeCodeSubscriptionHeaders = (
  apiKey: string,
  options: { includeOauthBeta?: boolean } = {},
): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': options.includeOauthBeta
    ? `oauth-2025-04-20,${CLAUDE_CODE_BETA_FLAGS}`
    : CLAUDE_CODE_BETA_FLAGS,
  'anthropic-dangerous-direct-browser-access': 'true',
  'user-agent': CLAUDE_CODE_USER_AGENT,
  'x-app': 'cli',
  'x-forwarded-server': claudeCodeForwardedServerId(),
  'x-stainless-arch': 'arm64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'MacOS',
  'x-stainless-package-version': CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  'x-stainless-timeout': '600',
});

export const COPILOT_EDITOR_VERSION = 'vscode/1.100.0';
export const COPILOT_PLUGIN_VERSION = 'copilot/1.300.0';

// Google shut down Gemini Code Assist for individuals. Personal Google
// subscriptions now authenticate as Antigravity (`agy`) against Cloud Code.
export const ANTIGRAVITY_CLI_VERSION = '1.21.9';
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

export function antigravityPlatform(_platform = process.platform): string {
  // Cloud Code's protobuf JSON parser currently rejects symbolic OS values
  // such as LINUX, WINDOWS, and MACOS with INVALID_ARGUMENT. The only stable
  // string enum accepted by loadCodeAssist/onboardUser is the zero value.
  return 'PLATFORM_UNSPECIFIED';
}

export function antigravityUserAgent(platform = process.platform, arch = process.arch): string {
  return `antigravity/${ANTIGRAVITY_CLI_VERSION} ${platform}/${arch}`;
}

export const ANTIGRAVITY_CLIENT_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: antigravityPlatform(),
  pluginType: 'GEMINI',
} as const;

export const buildAntigravitySubscriptionHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'User-Agent': antigravityUserAgent(),
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify(ANTIGRAVITY_CLIENT_METADATA),
});
