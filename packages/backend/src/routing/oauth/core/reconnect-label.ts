import { HttpException, HttpStatus } from '@nestjs/common';
import { ProviderService } from '../../routing-core/provider.service';
import { optionalTrimmedStringQuery } from './query-params';

/**
 * Resolve an optional reconnect label against this tenant's subscription
 * accounts. Absent means a new sign-in. A label that is not this tenant's
 * account is rejected before the provider dance starts, so a reconnect cannot
 * be aimed at another tenant or at a name that would create a new row.
 */
export async function resolveReconnectLabel(
  providerService: ProviderService,
  tenantId: string,
  provider: string,
  label: string | string[] | undefined,
): Promise<string | undefined> {
  const requested = optionalTrimmedStringQuery(label, 'label');
  if (!requested) return undefined;
  const stored = await providerService.findSubscriptionLabel(tenantId, provider, requested);
  if (!stored) {
    throw new HttpException(
      `No ${provider} account with that name to reconnect`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return stored;
}
