import { BadRequestException } from '@nestjs/common';
import { ProviderService } from '../../routing-core/provider.service';

/**
 * Label to persist a finished sign-in under. A reconnect overwrites the
 * account it started against; if that row was deleted mid-flow, fail instead
 * of allocating a new one (a new row also counts against the key cap).
 */
export async function resolveStoredOrNextLabel(
  providerService: ProviderService,
  tenantId: string,
  provider: string,
  reconnectLabel: string | undefined,
): Promise<string | undefined> {
  if (!reconnectLabel) return providerService.nextOAuthLabel(tenantId, provider);
  const stored = await providerService.findSubscriptionLabel(tenantId, provider, reconnectLabel);
  if (!stored) {
    throw new BadRequestException(
      'That account was removed. Connect it again instead of reconnecting it.',
    );
  }
  return stored;
}
