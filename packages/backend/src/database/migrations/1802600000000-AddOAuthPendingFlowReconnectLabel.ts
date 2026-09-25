import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an Anthropic sign-in overwrite one existing account instead of
 * allocating a new label. The label rides on the pending flow because that
 * state lives in Postgres (one active flow per provider+agent+tenant) and is
 * consumed at exchange, after the browser round-trip.
 */
export class AddOAuthPendingFlowReconnectLabel1802600000000 implements MigrationInterface {
  name = 'AddOAuthPendingFlowReconnectLabel1802600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "oauth_pending_flows"
      ADD COLUMN IF NOT EXISTS "reconnect_label" varchar
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "oauth_pending_flows"
      DROP COLUMN IF EXISTS "reconnect_label"
    `);
  }
}
