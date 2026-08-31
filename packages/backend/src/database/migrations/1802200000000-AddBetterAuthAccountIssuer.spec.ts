import { AddBetterAuthAccountIssuer1802200000000 } from './1802200000000-AddBetterAuthAccountIssuer';

describe('AddBetterAuthAccountIssuer1802200000000', () => {
  const queryRunner = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    queryRunner.query.mockImplementation(async (sql: string) => {
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
});
