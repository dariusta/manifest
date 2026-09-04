import { ProviderCredentialHealthService } from './provider-credential-health.service';

describe('ProviderCredentialHealthService', () => {
  const scope = {
    tenantId: 'tenant-1',
    provider: 'anthropic',
    authType: 'subscription' as const,
    label: 'Darius Extra claude plan 20x',
  };

  it('reports a credential healthy until it is marked exhausted', () => {
    const health = new ProviderCredentialHealthService();
    expect(health.isExhausted(scope)).toBe(false);
    health.markExhausted(scope, 'extra usage spent');
    expect(health.isExhausted(scope)).toBe(true);
  });

  it('scopes the verdict to one connection, not the whole provider', () => {
    const health = new ProviderCredentialHealthService();
    health.markExhausted(scope, 'extra usage spent');
    expect(health.isExhausted({ ...scope, label: 'victor plus' })).toBe(false);
  });

  it('matches labels case-insensitively so a renamed pin still resolves', () => {
    const health = new ProviderCredentialHealthService();
    health.markExhausted(scope, 'extra usage spent');
    expect(health.isExhausted({ ...scope, label: scope.label.toUpperCase() })).toBe(true);
  });

  it('clears the cooldown once the window lapses', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
    try {
      const health = new ProviderCredentialHealthService();
      health.markExhausted(scope, 'extra usage spent');
      jest.setSystemTime(new Date('2026-09-03T12:14:00Z'));
      expect(health.isExhausted(scope)).toBe(true);
      jest.setSystemTime(new Date('2026-09-03T12:16:00Z'));
      expect(health.isExhausted(scope)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a recovered credential be marked healthy again', () => {
    const health = new ProviderCredentialHealthService();
    health.markExhausted(scope, 'extra usage spent');
    health.markHealthy(scope);
    expect(health.isExhausted(scope)).toBe(false);
  });
});
