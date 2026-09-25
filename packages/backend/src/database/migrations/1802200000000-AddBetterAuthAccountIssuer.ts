import { MigrationInterface, QueryRunner } from 'typeorm';

interface ProviderRow {
  providerId: string;
}

interface CountRow {
  count: string;
}

function providerIssuer(providerId: string): string {
  if (providerId === 'credential') return 'local:credential';
  if (providerId === 'siwe') return 'local:siwe';
  return `local:oauth:${encodeURIComponent(providerId)}`;
}

/**
 * `account` belongs to Better Auth, which installs it through its own migration
 * run — separate from, and not ordered against, the TypeORM chain. On a pristine
 * database the TypeORM migrations run first (`migrationsRun` at boot), so the
 * table legitimately does not exist yet and there is nothing to backfill:
 * Better Auth 1.7 creates `issuer` itself. Only a populated 1.6 table needs this
 * migration, so probe before touching it rather than assuming ownership.
 */
async function accountTableExists(queryRunner: QueryRunner): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'account'`,
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Better Auth 1.7 keys accounts by (issuer, accountId). Populated 1.6 tables
 * must be backfilled before the new required column and compound index can be
 * installed; applying the generated schema directly is intentionally blocked.
 *
 * Manifest preserves the old provider-scoped identity model, so each external
 * provider receives Better Auth's deterministic provider-id namespace.
 */
export class AddBetterAuthAccountIssuer1802200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await accountTableExists(queryRunner))) return;

    await queryRunner.query(`ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text`);

    // Credential identity is the linked user's stable id in Better Auth 1.7.
    await queryRunner.query(`
      UPDATE "account"
      SET "accountId" = "userId"
      WHERE "providerId" = 'credential' AND "accountId" <> "userId"
    `);

    const providers = (await queryRunner.query(`
      SELECT DISTINCT "providerId"
      FROM "account"
      WHERE "issuer" IS NULL
      ORDER BY "providerId"
    `)) as ProviderRow[];

    for (const { providerId } of providers) {
      await queryRunner.query(
        `UPDATE "account" SET "issuer" = $1 WHERE "issuer" IS NULL AND "providerId" = $2`,
        [providerIssuer(providerId), providerId],
      );
    }

    const [missing] = (await queryRunner.query(`
      SELECT COUNT(*)::text AS "count"
      FROM "account"
      WHERE "issuer" IS NULL OR "accountId" IS NULL
    `)) as CountRow[];
    if (Number(missing?.count ?? 0) > 0) {
      throw new Error('Better Auth account identity backfill left rows without an identity');
    }

    const [collisions] = (await queryRunner.query(`
      SELECT COUNT(*)::text AS "count"
      FROM (
        SELECT "issuer", "accountId"
        FROM "account"
        GROUP BY "issuer", "accountId"
        HAVING COUNT(*) > 1
      ) AS "identity_collisions"
    `)) as CountRow[];
    if (Number(collisions?.count ?? 0) > 0) {
      throw new Error(
        `Better Auth account identity backfill found ${collisions.count} collision group(s)`,
      );
    }

    await queryRunner.query(`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx"
      ON "account" ("issuer", "accountId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await accountTableExists(queryRunner))) return;

    await queryRunner.query(`DROP INDEX IF EXISTS "account_issuer_accountId_uidx"`);
    await queryRunner.query(`ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer"`);
  }
}
