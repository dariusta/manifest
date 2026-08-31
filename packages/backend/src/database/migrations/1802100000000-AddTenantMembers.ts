import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-user workspaces: membership rows for users granted access to a
 * tenant beyond its owner. Owners are intentionally absent — the implicit
 * owner membership is derived from `tenants.owner_user_id`, so this ships
 * with no backfill and existing installs are unaffected until a member is
 * actually added.
 */
export class AddTenantMembers1802100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_members" (
        "tenant_id" varchar NOT NULL,
        "user_id" varchar NOT NULL,
        "role" varchar NOT NULL DEFAULT 'member',
        "added_by_user_id" varchar,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_members" PRIMARY KEY ("tenant_id", "user_id"),
        CONSTRAINT "FK_tenant_members_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_members_user" ON "tenant_members" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_members"`);
  }
}
