import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  SuperadminService,
  SUPERADMIN_EMAILS_ENV,
  parseSuperadminEmails,
} from './superadmin.service';

describe('parseSuperadminEmails', () => {
  it('returns an empty set for unset/blank values', () => {
    expect(parseSuperadminEmails(undefined).size).toBe(0);
    expect(parseSuperadminEmails(null).size).toBe(0);
    expect(parseSuperadminEmails('').size).toBe(0);
    expect(parseSuperadminEmails('   ,  ,').size).toBe(0);
  });

  it('lowercases and trims each entry', () => {
    const parsed = parseSuperadminEmails(' Ada@Example.COM , bob@example.com ');
    expect([...parsed]).toEqual(['ada@example.com', 'bob@example.com']);
  });
});

describe('SuperadminService', () => {
  const original = process.env[SUPERADMIN_EMAILS_ENV];
  let query: jest.Mock;

  async function build(configured: string | undefined): Promise<SuperadminService> {
    if (configured === undefined) delete process.env[SUPERADMIN_EMAILS_ENV];
    else process.env[SUPERADMIN_EMAILS_ENV] = configured;
    const module: TestingModule = await Test.createTestingModule({
      providers: [SuperadminService, { provide: getDataSourceToken(), useValue: { query } }],
    }).compile();
    return module.get(SuperadminService);
  }

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
  });

  afterAll(() => {
    if (original === undefined) delete process.env[SUPERADMIN_EMAILS_ENV];
    else process.env[SUPERADMIN_EMAILS_ENV] = original;
  });

  it('is disabled and never queries when the env var is unset', async () => {
    const service = await build(undefined);
    expect(service.enabled).toBe(false);
    expect(await service.isSuperadmin('user-1')).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('recognizes a configured email regardless of case', async () => {
    const service = await build('ada@example.com');
    query.mockResolvedValueOnce([{ email: 'Ada@Example.com' }]);
    expect(await service.isSuperadmin('user-1')).toBe(true);
  });

  it('rejects a user whose email is not configured', async () => {
    const service = await build('ada@example.com');
    query.mockResolvedValueOnce([{ email: 'mallory@example.com' }]);
    expect(await service.isSuperadmin('user-2')).toBe(false);
  });

  it('rejects an unknown user id (no row)', async () => {
    const service = await build('ada@example.com');
    query.mockResolvedValueOnce([]);
    expect(await service.isSuperadmin('ghost')).toBe(false);
  });

  it('returns false for a null/empty user id without querying', async () => {
    const service = await build('ada@example.com');
    expect(await service.isSuperadmin(null)).toBe(false);
    expect(await service.isSuperadmin('')).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('caches the decision so repeat checks do not re-hit the DB', async () => {
    const service = await build('ada@example.com');
    query.mockResolvedValue([{ email: 'ada@example.com' }]);
    await service.isSuperadmin('user-1');
    await service.isSuperadmin('user-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failed lookup — a DB hiccup must not deny access for the TTL', async () => {
    const service = await build('ada@example.com');
    query.mockRejectedValueOnce(new Error('connection reset'));
    expect(await service.isSuperadmin('user-1')).toBe(false);

    query.mockResolvedValueOnce([{ email: 'ada@example.com' }]);
    expect(await service.isSuperadmin('user-1')).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  describe('check() — the tri-state callers memoize against', () => {
    it("reports 'unknown' rather than false when the lookup fails", async () => {
      const service = await build('ada@example.com');
      query.mockRejectedValueOnce(new Error('connection reset'));
      // isSuperadmin() collapses this to false, but callers that cache their
      // own answer need to tell "not a superadmin" from "could not tell".
      expect(await service.check('user-1')).toBe('unknown');
    });

    it('reports plain false — not unknown — when superadmin is not configured', async () => {
      const service = await build(undefined);
      expect(await service.check('user-1')).toBe(false);
    });

    it('reports plain false for a missing user id', async () => {
      const service = await build('ada@example.com');
      expect(await service.check(null)).toBe(false);
    });
  });

  it('invalidate() forces the next check to re-hit the DB', async () => {
    const service = await build('ada@example.com');
    query.mockResolvedValue([{ email: 'ada@example.com' }]);
    await service.isSuperadmin('user-1');
    service.invalidate('user-1');
    await service.isSuperadmin('user-1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
