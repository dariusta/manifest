import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRoutingPresets1803200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "routing_presets" (
      "id" varchar PRIMARY KEY,
      "tenant_id" varchar NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
      "name" varchar(80) NOT NULL,
      "config" jsonb NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT NOW(),
      "updated_at" timestamp NOT NULL DEFAULT NOW(),
      CONSTRAINT "routing_presets_tenant_name" UNIQUE ("tenant_id", "name")
    )`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "routing_presets"');
  }
}
