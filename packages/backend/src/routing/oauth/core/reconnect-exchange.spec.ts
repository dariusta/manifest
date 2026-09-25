import { BadRequestException } from '@nestjs/common';
import { ProviderService } from '../../routing-core/provider.service';
import { resolveStoredOrNextLabel } from './reconnect-exchange';

function provider(stored: string | null = 'Darius Extra') {
  return {
    nextOAuthLabel: jest.fn().mockResolvedValue('Key 2'),
    findSubscriptionLabel: jest.fn().mockResolvedValue(stored),
  } as unknown as ProviderService;
}

describe('resolveStoredOrNextLabel', () => {
  it('allocates the next label when this is a new sign-in', async () => {
    const svc = provider();
    await expect(resolveStoredOrNextLabel(svc, 'tenant-1', 'anthropic', undefined)).resolves.toBe(
      'Key 2',
    );
    expect(svc.nextOAuthLabel).toHaveBeenCalledWith('tenant-1', 'anthropic');
    expect(svc.findSubscriptionLabel).not.toHaveBeenCalled();
  });

  it('returns the stored casing so the existing row is overwritten', async () => {
    const svc = provider('Darius Extra');
    await expect(
      resolveStoredOrNextLabel(svc, 'tenant-1', 'anthropic', 'darius extra'),
    ).resolves.toBe('Darius Extra');
    expect(svc.nextOAuthLabel).not.toHaveBeenCalled();
  });

  it('fails closed when the account was removed mid-flow', async () => {
    const svc = provider(null);
    await expect(
      resolveStoredOrNextLabel(svc, 'tenant-1', 'anthropic', 'Darius Extra'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.nextOAuthLabel).not.toHaveBeenCalled();
  });
});
