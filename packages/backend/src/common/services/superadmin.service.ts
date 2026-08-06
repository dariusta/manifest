import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TtlFifoCache } from '../utils/ttl-fifo-cache';

/** Comma-separated, case-insensitive. Empty/unset disables superadmin entirely. */
export const SUPERADMIN_EMAILS_ENV = 'MANIFEST_SUPERADMIN_EMAILS';

export function parseSuperadminEmails(raw: string | undefined | null): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

/**
 * Instance-level superadmins: operators who may see and act in EVERY active
 * workspace on this instance.
 *
 * The list lives in the deploy environment, not the database, on purpose.
 * Superadmin is an instance-operator privilege rather than an in-app role, so
 * it must not be grantable from inside the product — no UI, no API, and no
 * amount of workspace-admin access can mint one. Changing it requires
 * changing the deployment, which is exactly the audit trail we want.
 *
 * Membership is resolved by email (stable, human-meaningful) rather than user
 * id (opaque, only knowable after signup), so an operator can configure it
 * before the account exists.
 */
@Injectable()
export class SuperadminService {
  private readonly logger = new Logger(SuperadminService.name);
  private readonly emails: ReadonlySet<string>;

  // userId → is-superadmin. 'unknown' marks a failed lookup so a transient DB
  // error is never memoized as a denial for the full TTL.
  private readonly cache = new TtlFifoCache<string, boolean | 'unknown'>({
    maxEntries: 1_000,
    ttlMs: 300_000,
  });

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    this.emails = parseSuperadminEmails(process.env[SUPERADMIN_EMAILS_ENV]);
    if (this.emails.size > 0) {
      this.logger.log(
        `Superadmin access enabled for ${this.emails.size} configured email(s) via ${SUPERADMIN_EMAILS_ENV}.`,
      );
    }
  }

  /** False on every instance that has not configured the env var — the default. */
  get enabled(): boolean {
    return this.emails.size > 0;
  }

  /**
   * Tri-state on purpose. 'unknown' means the lookup itself failed, which is
   * NOT the same as "not a superadmin" — callers that memoize their own answer
   * must be able to tell the two apart, or a one-off DB hiccup gets cached as a
   * denial long after the database recovered.
   */
  async check(userId: string | null | undefined): Promise<boolean | 'unknown'> {
    if (!this.enabled || !userId) return false;
    return this.cache.resolve(
      userId,
      async (id) => {
        try {
          const rows: Array<{ email: string | null }> = await this.dataSource.query(
            `SELECT "email" FROM "user" WHERE "id" = $1 LIMIT 1`,
            [id],
          );
          const email = rows[0]?.email;
          return typeof email === 'string' && this.emails.has(email.trim().toLowerCase());
        } catch (err) {
          this.logger.warn(`Superadmin lookup failed for user: ${(err as Error).message}`);
          return 'unknown' as const;
        }
      },
      (value) => value !== 'unknown',
    );
  }

  /** Fail-closed boolean view of check(): an unknown result is not a grant. */
  async isSuperadmin(userId: string | null | undefined): Promise<boolean> {
    return (await this.check(userId)) === true;
  }

  /** Drop a cached decision (e.g. after the user's email changes). */
  invalidate(userId: string): void {
    this.cache.invalidate(userId);
  }
}
