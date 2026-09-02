import {
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
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-stainless-arch']).toBeDefined();
    expect(headers['x-stainless-os']).toBeDefined();
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
});
