import { AddBetterAuthAccountIssuer1802200000000 } from './1802200000000-AddBetterAuthAccountIssuer';

describe('AddBetterAuthAccountIssuer1802200000000', () => {
  const queryRunner = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ exists: 1 }];
      if (sql.includes('SELECT DISTINCT')) {
        return [{ providerId: 'credential' }, { providerId: 'team/github' }];
      }
      if (sql.includes('WHERE "issuer" IS NULL OR')) return [{ count: '0' }];
      if (sql.includes('identity_collisions')) return [{ count: '0' }];
      return [];
    });
  });

  it('backfills provider-id namespaces before enforcing the identity constraint', async () => {
    await new AddBetterAuthAccountIssuer1802200000000().up(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('SET "issuer" = $1'), [
      'local:credential',
      'credential',
    ]);
    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('SET "issuer" = $1'), [
      'local:oauth:team%2Fgithub',
      'team/github',
    ]);

    const statements = queryRunner.query.mock.calls.map(([sql]) => sql as string);
    expect(statements.findIndex((sql) => sql.includes('SET NOT NULL'))).toBeGreaterThan(
      statements.findIndex((sql) => sql.includes('identity_collisions')),
    );
    expect(statements.at(-1)).toContain('account_issuer_accountId_uidx');
  });

  it('fails before applying constraints when projected identities collide', async () => {
    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ exists: 1 }];
      if (sql.includes('SELECT DISTINCT')) return [{ providerId: 'credential' }];
      if (sql.includes('WHERE "issuer" IS NULL OR')) return [{ count: '0' }];
      if (sql.includes('identity_collisions')) return [{ count: '2' }];
      return [];
    });

    await expect(
      new AddBetterAuthAccountIssuer1802200000000().up(queryRunner as never),
    ).rejects.toThrow('2 collision group(s)');
    expect(
      queryRunner.query.mock.calls.some(([sql]) => (sql as string).includes('SET NOT NULL')),
    ).toBe(false);
  });

  describe('when Better Auth has not installed its tables yet', () => {
    // A fresh install runs the TypeORM chain at boot before Better Auth creates
    // `account`. Touching it here aborted every later migration, so the app
    // could never boot on an empty database and any `dropSchema` test suite
    // died on the same statement.
    beforeEach(() => {
      queryRunner.query.mockImplementation(async () => []);
    });

    it('leaves a pristine database untouched', async () => {
      await new AddBetterAuthAccountIssuer1802200000000().up(queryRunner as never);

      expect(queryRunner.query).toHaveBeenCalledTimes(1);
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
      );
    });

    it('reverts to a no-op as well', async () => {
      await new AddBetterAuthAccountIssuer1802200000000().down(queryRunner as never);

      expect(queryRunner.query).toHaveBeenCalledTimes(1);
      expect(queryRunner.query).not.toHaveBeenCalledWith(expect.stringContaining('DROP INDEX'));
    });
  });

  it('drops the index before the column when reverting a populated table', async () => {
    await new AddBetterAuthAccountIssuer1802200000000().down(queryRunner as never);

    const statements = queryRunner.query.mock.calls.map(([sql]) => sql as string);
    expect(statements.findIndex((sql) => sql.includes('DROP INDEX'))).toBeLessThan(
      statements.findIndex((sql) => sql.includes('DROP COLUMN')),
    );
  });
});
