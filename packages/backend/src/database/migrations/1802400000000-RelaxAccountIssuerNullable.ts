import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `account` is Better Auth's table and is created by its own migration run, so a
 * pristine database reaches the TypeORM chain without it. See
 * `1802200000000-AddBetterAuthAccountIssuer` — the pair has to agree on skipping.
 */
async function accountTableExists(queryRunner: QueryRunner): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'account'`,
  )) as unknown[];
  return rows.length > 0;
}

/**
 * better-auth@1.6.25 does not send an `issuer` for credential (email/password)
 * accounts — the issuer column was made NOT NULL for a 1.7 upgrade that has not
 * shipped, which broke every email sign-up with:
 *   null value in column "issuer" of relation "account" violates not-null constraint
 *
 * Relax the column back to nullable. Existing backfilled values are preserved,
 * and the (issuer, "accountId") unique index remains valid: Postgres treats
 * NULLs as distinct, and provider-scoped identity still comes from providerId.
 */
export class RelaxAccountIssuerNullable1802400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await accountTableExists(queryRunner))) return;

    await queryRunner.query(`ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await accountTableExists(queryRunner))) return;

    // Backfill anything NULL before re-tightening so the reverse is safe.
    await queryRunner.query(`
      UPDATE "account" SET "issuer" = 'local:' || "providerId"
      WHERE "issuer" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`);
  }
}
