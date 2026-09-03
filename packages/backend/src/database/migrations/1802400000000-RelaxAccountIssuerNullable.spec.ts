import { RelaxAccountIssuerNullable1802400000000 } from './1802400000000-RelaxAccountIssuerNullable';

describe('RelaxAccountIssuerNullable1802400000000', () => {
  let queryRunner: { query: jest.Mock };

  beforeEach(() => {
    queryRunner = { query: jest.fn().mockResolvedValue([]) };
  });

  it('drops the NOT NULL constraint so better-auth 1.6 credential signups insert cleanly', async () => {
    await new RelaxAccountIssuerNullable1802400000000().up(queryRunner as never);
    const statements = queryRunner.query.mock.calls.map(([sql]) => sql as string);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL');
    // No destructive change: existing issuer values and indexes are untouched.
    expect(statements.join(' ')).not.toContain('DROP INDEX');
    expect(statements.join(' ')).not.toContain('DROP COLUMN');
  });

  it('backfills a local issuer before re-tightening on revert', async () => {
    await new RelaxAccountIssuerNullable1802400000000().down(queryRunner as never);
    const statements = queryRunner.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toContain(`SET "issuer" = 'local:' || "providerId"`);
    expect(statements[0]).toContain('WHERE "issuer" IS NULL');
    expect(statements.at(-1)).toContain('SET NOT NULL');
  });
});
