import { RelaxAccountIssuerNullable1802400000000 } from './1802400000000-RelaxAccountIssuerNullable';

describe('RelaxAccountIssuerNullable1802400000000', () => {
  let queryRunner: { query: jest.Mock };

  // Every `up`/`down` opens with the Better Auth table probe; the assertions
  // below are about the statements that follow it.
  const PROBE = 'information_schema.tables';
  const issued = () =>
    queryRunner.query.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => !sql.includes(PROBE));

  beforeEach(() => {
    queryRunner = { query: jest.fn().mockResolvedValue([{ exists: 1 }]) };
  });

  it('drops the NOT NULL constraint so better-auth 1.6 credential signups insert cleanly', async () => {
    await new RelaxAccountIssuerNullable1802400000000().up(queryRunner as never);
    const statements = issued();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL');
    // No destructive change: existing issuer values and indexes are untouched.
    expect(statements.join(' ')).not.toContain('DROP INDEX');
    expect(statements.join(' ')).not.toContain('DROP COLUMN');
  });

  it('backfills a local issuer before re-tightening on revert', async () => {
    await new RelaxAccountIssuerNullable1802400000000().down(queryRunner as never);
    const statements = issued();
    expect(statements[0]).toContain(`SET "issuer" = 'local:' || "providerId"`);
    expect(statements[0]).toContain('WHERE "issuer" IS NULL');
    expect(statements.at(-1)).toContain('SET NOT NULL');
  });

  // A fresh install runs these migrations before Better Auth creates `account`.
  // Without the probe the whole chain aborted here and the app never booted.
  it('skips a pristine database in both directions', async () => {
    queryRunner.query.mockResolvedValue([]);

    await new RelaxAccountIssuerNullable1802400000000().up(queryRunner as never);
    await new RelaxAccountIssuerNullable1802400000000().down(queryRunner as never);

    expect(issued()).toEqual([]);
    expect(queryRunner.query).toHaveBeenCalledTimes(2);
  });
});
