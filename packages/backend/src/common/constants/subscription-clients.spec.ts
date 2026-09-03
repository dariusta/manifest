import {
  ANTIGRAVITY_CLI_VERSION,
  antigravityPlatform,
  antigravityUserAgent,
  buildAntigravitySubscriptionHeaders,
  buildClaudeCodeSubscriptionHeaders,
  claudeCodeForwardedServerId,
  claudeCodeStainlessArch,
  claudeCodeStainlessOs,
} from './subscription-clients';

describe('claudeCodeStainlessArch', () => {
  it.each([
    ['arm64', 'arm64'],
    ['x64', 'x64'],
    ['mips', 'Other:mips'],
  ])('maps %s to %s', (arch, expected) => {
    expect(claudeCodeStainlessArch(arch as NodeJS.Architecture)).toBe(expected);
  });
});

describe('claudeCodeStainlessOs', () => {
  it.each([
    ['darwin', 'MacOS'],
    ['linux', 'Linux'],
    ['win32', 'Windows'],
    ['freebsd', 'FreeBSD'],
    ['sunos', 'Other:sunos'],
  ])('maps %s to %s', (platform, expected) => {
    expect(claudeCodeStainlessOs(platform as NodeJS.Platform)).toBe(expected);
  });
});

describe('buildClaudeCodeSubscriptionHeaders', () => {
  it('sets the bearer token and stainless metadata headers', () => {
    const headers = buildClaudeCodeSubscriptionHeaders('key-123');
    expect(headers.Authorization).toBe('Bearer key-123');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-stainless-arch']).toBeDefined();
    expect(headers['x-stainless-os']).toBeDefined();
    expect(headers['x-forwarded-server']).toMatch(/^[a-f0-9]{12}$/);
    expect(headers['x-stainless-package-version']).toBe('0.112.1');
    expect(headers['x-stainless-runtime-version']).toBe('v26.3.0');
  });

  it('identifies as Claude Code 2.1.251+ so Fable 5.1 is not rejected', () => {
    const headers = buildClaudeCodeSubscriptionHeaders('key-123');
    expect(headers['user-agent']).toBe('claude-cli/2.1.258 (external, sdk-cli)');
    const match = headers['user-agent']?.match(/^claude-cli\/(\d+)\.(\d+)\.(\d+) /);
    expect(match).not.toBeNull();
    const [, major, minor, patch] = match!;
    const version = Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
    const minimumFable51 = 2 * 1_000_000 + 1 * 1_000 + 251;
    expect(version).toBeGreaterThanOrEqual(minimumFable51);
  });

  it('generates a stable opaque forwarded-server id from the Manifest public URL', () => {
    const url = 'https://manifest.example.com';
    expect(claudeCodeForwardedServerId(url)).toMatch(/^[a-f0-9]{12}$/);
    expect(claudeCodeForwardedServerId(url)).toBe(claudeCodeForwardedServerId(url));
  });

  it('adds the OAuth beta only for private OAuth endpoints', () => {
    const inference = buildClaudeCodeSubscriptionHeaders('key-123');
    const oauth = buildClaudeCodeSubscriptionHeaders('key-123', { includeOauthBeta: true });
    expect(inference['anthropic-beta']).not.toContain('oauth-2025-04-20');
    expect(oauth['anthropic-beta']).toContain('oauth-2025-04-20');
  });
});

describe('antigravityPlatform', () => {
  it.each(['darwin', 'linux', 'win32', 'sunos'])(
    'uses the protobuf zero value for %s because Cloud Code rejects symbolic OS enums',
    (platform) => {
      expect(antigravityPlatform(platform as NodeJS.Platform)).toBe('PLATFORM_UNSPECIFIED');
    },
  );
});

describe('buildAntigravitySubscriptionHeaders', () => {
  it('identifies as Antigravity so personal Google accounts are not rejected', () => {
    const headers = buildAntigravitySubscriptionHeaders('ya29.token');
    expect(headers.Authorization).toBe('Bearer ya29.token');
    expect(headers['User-Agent']).toBe(antigravityUserAgent());
    expect(headers['User-Agent']).toContain(`antigravity/${ANTIGRAVITY_CLI_VERSION}`);
    expect(headers['X-Goog-Api-Client']).toBe('google-cloud-sdk vscode_cloudshelleditor/0.1');
    expect(JSON.parse(headers['Client-Metadata']!)).toEqual({
      ideType: 'ANTIGRAVITY',
      platform: antigravityPlatform(),
      pluginType: 'GEMINI',
    });
  });
});
