import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds an optional operator-defined 30-day USD allowance per provider connection. */
export class AddManualUsageLimit1802300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      ADD COLUMN IF NOT EXISTS "manual_usage_limit_usd" numeric(14,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      DROP COLUMN IF EXISTS "manual_usage_limit_usd"
    `);
  }
}
