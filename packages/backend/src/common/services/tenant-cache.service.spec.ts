import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TenantCacheService } from './tenant-cache.service';
import { SuperadminService } from './superadmin.service';
import { Tenant } from '../../entities/tenant.entity';
import { TenantMember } from '../../entities/tenant-member.entity';

describe('TenantCacheService', () => {
  let service: TenantCacheService;
  let mockFindOne: jest.Mock;
  let mockInsert: jest.Mock;
  let mockMemberFindOne: jest.Mock;
  let mockCheck: jest.Mock;

  beforeEach(async () => {
    mockFindOne = jest.fn();
    mockInsert = jest.fn().mockResolvedValue({});
    mockMemberFindOne = jest.fn().mockResolvedValue(null);
    mockCheck = jest.fn().mockResolvedValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantCacheService,
        {
          provide: SuperadminService,
          useValue: {
            check: mockCheck,
            isSuperadmin: jest.fn().mockResolvedValue(false),
            enabled: false,
          },
        },
        {
          provide: getRepositoryToken(Tenant),
          useValue: { findOne: mockFindOne, insert: mockInsert },
        },
        {
          provide: getRepositoryToken(TenantMember),
          useValue: {
            findOne: mockMemberFindOne,
            find: jest.fn().mockResolvedValue([]),
            insert: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
      ],
    }).compile();
    service = module.get<TenantCacheService>(TenantCacheService);
  });

  it('returns tenantId when the tenant exists', async () => {
    mockFindOne.mockResolvedValueOnce({ id: 'tenant-abc', owner_user_id: 'user-1' });
    expect(await service.resolve('user-1')).toBe('tenant-abc');
    expect(mockFindOne).toHaveBeenCalledWith({ where: { owner_user_id: 'user-1' } });
  });

  it('returns null when the tenant is missing', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    expect(await service.resolve('unknown')).toBeNull();
  });

  it('caches subsequent lookups for the same user', async () => {
    mockFindOne.mockResolvedValueOnce({ id: 'tenant-abc' });
    await service.resolve('user-1');
    await service.resolve('user-1');
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a missing tenant — re-queries until one exists (first-run 404 regression)', async () => {
    // First resolve: the user has no tenant yet (e.g. the create-agent guard
    // runs before its handler creates the tenant).
    mockFindOne.mockResolvedValueOnce(null);
    expect(await service.resolve('user-1')).toBeNull();

    // The tenant is created between the two calls.
    mockFindOne.mockResolvedValueOnce({ id: 'tenant-created' });
    expect(await service.resolve('user-1')).toBe('tenant-created');

    // The null was never cached, so the second call had to re-hit the DB —
    // otherwise the freshly created tenant would stay invisible for the TTL and
    // provider/routing endpoints would 404 "Tenant not found".
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next resolve() to re-hit the DB', async () => {
    // First resolve populates the cache.
    mockFindOne.mockResolvedValueOnce({ id: 'tenant-abc' });
    await service.resolve('user-1');
    expect(mockFindOne).toHaveBeenCalledTimes(1);

    // Invalidate clears the cached entry.
    service.invalidate('user-1');

    // Next resolve must re-query.
    mockFindOne.mockResolvedValueOnce({ id: 'tenant-abc-refreshed' });
    const result = await service.resolve('user-1');
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    expect(result).toBe('tenant-abc-refreshed');
  });

  it('invalidate() on an unknown user is a no-op (does not throw)', () => {
    expect(() => service.invalidate('no-such-user')).not.toThrow();
  });

  describe('ensureForUser', () => {
    it('returns the existing tenant id without inserting when one exists', async () => {
      mockFindOne.mockResolvedValueOnce({ id: 'tenant-existing' });
      const result = await service.ensureForUser('user-1');
      expect(result).toBe('tenant-existing');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('inserts a new tenant keyed by owner_user_id when none exists', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      const result = await service.ensureForUser('user-2');
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const inserted = mockInsert.mock.calls[0][0];
      expect(inserted).toEqual(
        expect.objectContaining({
          id: result,
          name: 'user-2',
          owner_user_id: 'user-2',
          is_active: true,
        }),
      );
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('re-finds by owner_user_id when the insert races and loses', async () => {
      // resolve() finds nothing → attempt insert → insert throws (unique
      // index on owner_user_id) → re-find returns the surviving row.
      mockFindOne.mockResolvedValueOnce(null);
      mockInsert.mockRejectedValueOnce(new Error('duplicate key value'));
      mockFindOne.mockResolvedValueOnce({ id: 'tenant-raced' });

      const result = await service.ensureForUser('user-3');
      expect(result).toBe('tenant-raced');
      // Second findOne is the post-race re-find, scoped by owner_user_id.
      expect(mockFindOne).toHaveBeenLastCalledWith({ where: { owner_user_id: 'user-3' } });
    });

    it('rethrows the original insert error when the re-find finds nothing (not a race)', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      mockInsert.mockRejectedValueOnce(new Error('connection terminated'));
      mockFindOne.mockResolvedValueOnce(null);

      await expect(service.ensureForUser('user-4')).rejects.toThrow('connection terminated');
    });
  });

  describe('sharedProviderTenantIds', () => {
    // Own setup: sharedProviderTenantIds needs tenantRepo.findOne + createQueryBuilder
    // and memberRepo.find, which the top-level mocks above don't all provide.
    let svc: TenantCacheService;
    let tenantFindOne: jest.Mock;
    let memberFind: jest.Mock;
    let activeTeamIds: string[];

    beforeEach(async () => {
      tenantFindOne = jest.fn();
      memberFind = jest.fn().mockResolvedValue([]);
      activeTeamIds = [];
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(() => Promise.resolve(activeTeamIds.map((id) => ({ id })))),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          TenantCacheService,
          {
            provide: SuperadminService,
            useValue: { check: jest.fn().mockResolvedValue(false), enabled: false },
          },
          {
            provide: getRepositoryToken(Tenant),
            useValue: { findOne: tenantFindOne, createQueryBuilder: jest.fn(() => qb) },
          },
          {
            provide: getRepositoryToken(TenantMember),
            useValue: { find: memberFind },
          },
        ],
      }).compile();
      svc = module.get<TenantCacheService>(TenantCacheService);
    });

    it('personal workspace borrows from every active team its owner belongs to', async () => {
      tenantFindOne.mockResolvedValueOnce({ id: 'personal-1', owner_user_id: 'user-1' });
      memberFind.mockResolvedValueOnce([
        { tenant_id: 'team-a', user_id: 'user-1' },
        { tenant_id: 'team-b', user_id: 'user-1' },
      ]);
      activeTeamIds = ['team-a', 'team-b'];

      expect(await svc.sharedProviderTenantIds('personal-1')).toEqual(['team-a', 'team-b']);
      expect(memberFind).toHaveBeenCalledWith({ where: { user_id: 'user-1' } });
    });

    it('excludes inactive teams (only active team ids come back from the query)', async () => {
      tenantFindOne.mockResolvedValueOnce({ id: 'personal-1', owner_user_id: 'user-1' });
      memberFind.mockResolvedValueOnce([
        { tenant_id: 'team-a', user_id: 'user-1' },
        { tenant_id: 'team-dead', user_id: 'user-1' },
      ]);
      activeTeamIds = ['team-a']; // team-dead filtered out by t.is_active = true

      expect(await svc.sharedProviderTenantIds('personal-1')).toEqual(['team-a']);
    });

    it('a team workspace (no owner) borrows from nobody', async () => {
      tenantFindOne.mockResolvedValueOnce({ id: 'team-a', owner_user_id: null });

      expect(await svc.sharedProviderTenantIds('team-a')).toEqual([]);
      expect(memberFind).not.toHaveBeenCalled();
    });

    it('returns [] when the owner belongs to no teams', async () => {
      tenantFindOne.mockResolvedValueOnce({ id: 'personal-1', owner_user_id: 'user-1' });
      memberFind.mockResolvedValueOnce([]);

      expect(await svc.sharedProviderTenantIds('personal-1')).toEqual([]);
    });

    it('never borrows from the acting tenant itself', async () => {
      tenantFindOne.mockResolvedValueOnce({ id: 'personal-1', owner_user_id: 'user-1' });
      // A stray self-membership row must not turn into a self-borrow.
      memberFind.mockResolvedValueOnce([
        { tenant_id: 'personal-1', user_id: 'user-1' },
        { tenant_id: 'team-a', user_id: 'user-1' },
      ]);
      activeTeamIds = ['team-a'];

      expect(await svc.sharedProviderTenantIds('personal-1')).toEqual(['team-a']);
    });
  });
});

describe('TenantCacheService — instance superadmins', () => {
  let svc: TenantCacheService;
  let tenantFindOne: jest.Mock;
  let memberFindOne: jest.Mock;
  let check: jest.Mock;

  beforeEach(async () => {
    tenantFindOne = jest.fn();
    memberFindOne = jest.fn().mockResolvedValue(null);
    check = jest.fn().mockResolvedValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantCacheService,
        { provide: SuperadminService, useValue: { check, enabled: true } },
        {
          provide: getRepositoryToken(Tenant),
          useValue: { findOne: tenantFindOne, find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(TenantMember),
          useValue: { findOne: memberFindOne, find: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();
    svc = module.get(TenantCacheService);
  });

  it("grants 'owner' in a workspace the superadmin neither owns nor belongs to", async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: 'foreign',
      owner_user_id: 'someone-else',
      is_active: true,
    });
    check.mockResolvedValueOnce(true);

    expect(await svc.roleFor('admin-1', 'foreign')).toBe('owner');
    // The membership lookup is skipped — superadmin already outranks any row.
    expect(memberFindOne).not.toHaveBeenCalled();
  });

  it('does NOT grant access to an inactive workspace', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: 'archived',
      owner_user_id: 'someone-else',
      is_active: false,
    });
    check.mockResolvedValue(true);

    // Superadmin must not resurrect a disabled workspace: is_active is checked
    // before the superadmin branch, so the answer is a plain "no access".
    expect(await svc.roleFor('admin-1', 'archived')).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('does not memoize a denial when the superadmin lookup itself failed', async () => {
    // A transient DB error must not be cached as "not a superadmin": doing so
    // would lock a real superadmin out of every foreign workspace for the full
    // 60s role-cache TTL, long after the database recovered.
    tenantFindOne.mockResolvedValue({
      id: 'foreign',
      owner_user_id: 'someone-else',
      is_active: true,
    });
    check.mockResolvedValueOnce('unknown');

    // This request fails closed…
    expect(await svc.roleFor('admin-1', 'foreign')).toBeNull();
    // …and the membership fallback is skipped, so no 'none' can be cached.
    expect(memberFindOne).not.toHaveBeenCalled();

    // …but the very next one re-checks and succeeds.
    check.mockResolvedValueOnce(true);
    expect(await svc.roleFor('admin-1', 'foreign')).toBe('owner');
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('leaves a non-superadmin exactly as before', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: 'foreign',
      owner_user_id: 'someone-else',
      is_active: true,
    });
    check.mockResolvedValueOnce(false);
    memberFindOne.mockResolvedValueOnce(null);

    expect(await svc.roleFor('stranger', 'foreign')).toBeNull();
  });

  it('resolveActive honors a cookie pointing at a foreign workspace for a superadmin', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: 'foreign',
      owner_user_id: 'someone-else',
      is_active: true,
    });
    check.mockResolvedValueOnce(true);

    expect(await svc.resolveActive('admin-1', 'foreign')).toEqual({
      tenantId: 'foreign',
      role: 'owner',
    });
  });

  it('resolveActive still rejects that cookie for a non-superadmin', async () => {
    // Cookie lookup: not a member -> falls back to the user's own tenant.
    tenantFindOne.mockResolvedValueOnce({
      id: 'foreign',
      owner_user_id: 'someone-else',
      is_active: true,
    });
    memberFindOne.mockResolvedValueOnce(null);
    // Fallback resolve() -> owned tenant, then roleFor() on it.
    tenantFindOne.mockResolvedValueOnce({ id: 'own', owner_user_id: 'stranger', is_active: true });
    tenantFindOne.mockResolvedValueOnce({ id: 'own', owner_user_id: 'stranger', is_active: true });

    expect(await svc.resolveActive('stranger', 'foreign')).toEqual({
      tenantId: 'own',
      role: 'owner',
    });
  });
});
