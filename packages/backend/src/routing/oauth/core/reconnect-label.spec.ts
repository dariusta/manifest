import { HttpException, HttpStatus } from '@nestjs/common';
import { ProviderService } from '../../routing-core/provider.service';
import { resolveReconnectLabel } from './reconnect-label';

function provider(stored: string | null = 'Darius Extra') {
  return {
    findSubscriptionLabel: jest.fn().mockResolvedValue(stored),
  } as unknown as ProviderService;
}

describe('resolveReconnectLabel', () => {
  it('treats an absent or blank label as a new sign-in', async () => {
    const svc = provider();
    await expect(resolveReconnectLabel(svc, 'tenant-1', 'anthropic', undefined)).resolves.toBeUndefined();
    await expect(resolveReconnectLabel(svc, 'tenant-1', 'anthropic', '   ')).resolves.toBeUndefined();
    expect(svc.findSubscriptionLabel).not.toHaveBeenCalled();
  });

  it('rejects a repeated label query param', async () => {
    await expect(
      resolveReconnectLabel(provider(), 'tenant-1', 'anthropic', ['a', 'b']),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('returns the stored casing for a known account', async () => {
    const svc = provider('Darius Extra');
    await expect(
      resolveReconnectLabel(svc, 'tenant-1', 'anthropic', ' darius extra '),
    ).resolves.toBe('Darius Extra');
    expect(svc.findSubscriptionLabel).toHaveBeenCalledWith('tenant-1', 'anthropic', 'darius extra');
  });

  it('rejects a label that is not this tenant\'s account', async () => {
    const svc = provider(null);
    await expect(resolveReconnectLabel(svc, 'tenant-1', 'anthropic', 'ghost')).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(resolveReconnectLabel(svc, 'tenant-1', 'anthropic', 'ghost')).rejects.toThrow(
      'No anthropic account with that name to reconnect',
    );
  });
});
