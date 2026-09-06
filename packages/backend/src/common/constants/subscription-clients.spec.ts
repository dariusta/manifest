import {
  ANTIGRAVITY_CLI_VERSION,
  antigravityPlatform,
  antigravityUserAgent,
  buildAntigravitySubscriptionHeaders,
  buildClaudeCodeSubscriptionHeaders,
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
    expect(headers.accept).toBe('application/json');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-stainless-arch']).toBe('arm64');
    expect(headers['x-stainless-os']).toBe('MacOS');
    expect(headers).not.toHaveProperty('x-stainless-helper-method');
    expect(headers['x-stainless-package-version']).toBe('0.112.1');
    expect(headers['x-stainless-runtime-version']).toBe('v26.3.0');
  });

  it('identifies as Claude Code 2.1.251+ so Fable 5.1 is not rejected', () => {
    const headers = buildClaudeCodeSubscriptionHeaders('key-123');
    expect(headers['user-agent']).toBe('claude-cli/2.1.259 (external, sdk-cli)');
    const match = headers['user-agent']?.match(/^claude-cli\/(\d+)\.(\d+)\.(\d+) /);
    expect(match).not.toBeNull();
    const [, major, minor, patch] = match!;
    const version = Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
    const minimumFable51 = 2 * 1_000_000 + 1 * 1_000 + 251;
    expect(version).toBeGreaterThanOrEqual(minimumFable51);
  });

  it('ALWAYS includes the oauth beta flag so Anthropic treats the bearer token as first-party Claude Code', () => {
    // Without oauth-2025-04-20 Anthropic classifies the subscription token as
    // a third-party app and bills extra usage instead of plan limits
    // ("Third-party apps now draw from your extra usage…" 400).
    const headers = buildClaudeCodeSubscriptionHeaders('key-123');
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(headers['anthropic-beta']).toContain('context-management-2025-06-27');
    expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
    expect(headers['anthropic-beta']).toContain('fallback-credit-2026-06-01');
    expect(headers['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
  });

  it('matches the live Claude Code CLI identity that Anthropic bills as included usage', () => {
    const headers = buildClaudeCodeSubscriptionHeaders('key-123');
    expect(headers['user-agent']).toBe('claude-cli/2.1.259 (external, sdk-cli)');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-stainless-arch']).toBe('arm64');
    expect(headers['x-stainless-os']).toBe('MacOS');
    expect(headers['x-stainless-package-version']).toBe('0.112.1');
    expect(headers['x-stainless-runtime-version']).toBe('v26.3.0');
    expect(headers['x-stainless-timeout']).toBe('600');
    expect(headers['x-claude-code-session-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers['x-claude-code-agent-id']).toMatch(/^[a-f0-9]{16,17}$/);
    expect(headers['x-forwarded-server']).toMatch(/^[a-f0-9]{12}$/);
  });

  it('keeps Claude Code session identity stable for the same seed', () => {
    const first = buildClaudeCodeSubscriptionHeaders('key-123', 'sess-abc');
    const second = buildClaudeCodeSubscriptionHeaders('key-123', 'sess-abc');
    const other = buildClaudeCodeSubscriptionHeaders('key-123', 'sess-xyz');
    expect(first['x-claude-code-session-id']).toBe(second['x-claude-code-session-id']);
    expect(first['x-claude-code-agent-id']).toBe(second['x-claude-code-agent-id']);
    expect(first['x-forwarded-server']).toBe(second['x-forwarded-server']);
    expect(other['x-claude-code-session-id']).not.toBe(first['x-claude-code-session-id']);
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
