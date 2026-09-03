import { MigrationInterface, QueryRunner } from 'typeorm';

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
    await queryRunner.query(`ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill anything NULL before re-tightening so the reverse is safe.
    await queryRunner.query(`
      UPDATE "account" SET "issuer" = 'local:' || "providerId"
      WHERE "issuer" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`);
  }
}
