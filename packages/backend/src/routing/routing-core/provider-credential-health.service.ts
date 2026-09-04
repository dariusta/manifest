import { Injectable, Logger } from '@nestjs/common';
import type { AuthType } from 'manifest-shared';

/**
 * Scope of one stored credential (a `tenant_providers` row), as seen by key
 * selection. Label is the user-facing connection name ("victor plus").
 */
export interface CredentialScope {
  tenantId: string;
  provider: string;
  authType?: AuthType;
  label: string;
}

/**
 * How long a credential stays sidelined after the provider says its billing is
 * spent. Anthropic's extra-usage balance only recovers when the operator tops
 * it up, so a short retry window just resumes the hammering; a long one hides
 * a top-up that already happened. 15 minutes turns ~1500 doomed forwards per
 * afternoon into ~16 probes.
 */
const EXHAUSTED_COOLDOWN_MS = 15 * 60_000;

/** Bound the map so a large tenant can't grow it without limit. */
const MAX_TRACKED_CREDENTIALS = 2_000;

@Injectable()
export class ProviderCredentialHealthService {
  private readonly logger = new Logger(ProviderCredentialHealthService.name);
  private readonly exhaustedUntil = new Map<string, number>();

  /**
   * Sideline a credential the provider has rejected for billing reasons, so
   * key selection prefers a sibling connection until the window expires.
   */
  markExhausted(scope: CredentialScope, reason: string): void {
    const key = credentialKey(scope);
    const alreadyCooling = this.isExhausted(scope);
    this.evictIfFull();
    this.exhaustedUntil.set(key, Date.now() + EXHAUSTED_COOLDOWN_MS);
    if (!alreadyCooling) {
      this.logger.warn(
        `Sidelining ${scope.provider} connection "${scope.label}" for ` +
          `${EXHAUSTED_COOLDOWN_MS / 60_000}m: ${reason}`,
      );
    }
  }

  isExhausted(scope: CredentialScope): boolean {
    const key = credentialKey(scope);
    const until = this.exhaustedUntil.get(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.exhaustedUntil.delete(key);
      return false;
    }
    return true;
  }

  /** Clear a credential's cooldown — used when it serves a request again. */
  markHealthy(scope: CredentialScope): void {
    this.exhaustedUntil.delete(credentialKey(scope));
  }

  private evictIfFull(): void {
    if (this.exhaustedUntil.size < MAX_TRACKED_CREDENTIALS) return;
    const now = Date.now();
    for (const [key, until] of this.exhaustedUntil) {
      if (until <= now) this.exhaustedUntil.delete(key);
    }
    if (this.exhaustedUntil.size < MAX_TRACKED_CREDENTIALS) return;
    const oldest = this.exhaustedUntil.keys().next().value as string | undefined;
    if (oldest !== undefined) this.exhaustedUntil.delete(oldest);
  }
}

function credentialKey(scope: CredentialScope): string {
  return [
    scope.tenantId,
    scope.provider.toLowerCase(),
    scope.authType ?? '',
    scope.label.toLowerCase(),
  ].join('\0');
}
