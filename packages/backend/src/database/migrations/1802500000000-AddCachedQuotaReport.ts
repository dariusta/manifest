import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists the last successful provider quota probe per connection.
 *
 * The report was previously cached in process memory only, so a restart left a
 * persistently rate-limited provider (Anthropic's usage endpoint 429s readily)
 * with nothing to show but "Usage unavailable".
 */
export class AddCachedQuotaReport1802500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      ADD COLUMN IF NOT EXISTS "cached_quota_report" text
    `);
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      ADD COLUMN IF NOT EXISTS "cached_quota_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      DROP COLUMN IF EXISTS "cached_quota_report"
    `);
    await queryRunner.query(`
      ALTER TABLE "tenant_providers"
      DROP COLUMN IF EXISTS "cached_quota_at"
    `);
  }
}
