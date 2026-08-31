import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { WorkspacesService } from './workspaces.service';
import { Tenant } from '../entities/tenant.entity';
import { TenantMember } from '../entities/tenant-member.entity';
import { TenantCacheService } from '../common/services/tenant-cache.service';
import { SuperadminService } from '../common/services/superadmin.service';

describe('WorkspacesService.list', () => {
  let service: WorkspacesService;
  let listForUser: jest.Mock;
  let isSuperadmin: jest.Mock;
  let tenantFind: jest.Mock;
  let query: jest.Mock;

  beforeEach(async () => {
    listForUser = jest.fn().mockResolvedValue([]);
    isSuperadmin = jest.fn().mockResolvedValue(false);
    tenantFind = jest.fn().mockResolvedValue([]);
    query = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspacesService,
        { provide: getRepositoryToken(Tenant), useValue: { find: tenantFind, findOne: jest.fn() } },
        {
          provide: getRepositoryToken(TenantMember),
          useValue: { find: jest.fn(), findOne: jest.fn() },
        },
        { provide: getDataSourceToken(), useValue: { query } },
        { provide: TenantCacheService, useValue: { listForUser } },
        { provide: SuperadminService, useValue: { isSuperadmin } },
      ],
    }).compile();
    service = module.get(WorkspacesService);
  });

  it('returns only the caller’s own workspaces when they are not a superadmin', async () => {
    listForUser.mockResolvedValueOnce([{ id: 'own', name: 'Personal', role: 'owner' }]);

    expect(await service.list('user-1')).toEqual({
      workspaces: [{ id: 'own', name: 'Personal', role: 'owner' }],
      isSuperadmin: false,
    });
    // The instance-wide scan must not run for an ordinary user.
    expect(tenantFind).not.toHaveBeenCalled();
  });

  it('appends every other active workspace for a superadmin, flagged and owner-roled', async () => {
    listForUser.mockResolvedValueOnce([{ id: 'own', name: 'Personal', role: 'owner' }]);
    isSuperadmin.mockResolvedValueOnce(true);
    tenantFind.mockResolvedValueOnce([
      { id: 'own', name: 'user-1', owner_user_id: 'user-1' },
      { id: 'team', name: 'Mimic', owner_user_id: null },
    ]);

    const result = await service.list('user-1');

    expect(result.isSuperadmin).toBe(true);
    // 'own' appears once — the caller's own row wins, no duplicate from the scan.
    expect(result.workspaces).toEqual([
      { id: 'own', name: 'Personal', role: 'owner' },
      { id: 'team', name: 'Mimic', role: 'owner', viaSuperadmin: true },
    ]);
    expect(tenantFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true } }),
    );
  });

  it("labels another user's personal workspace by owner instead of a bare 'Personal'", async () => {
    isSuperadmin.mockResolvedValueOnce(true);
    tenantFind.mockResolvedValueOnce([
      // An auto-created personal tenant: name mirrors the opaque owner id.
      { id: 't-2', name: 'user-2', owner_user_id: 'user-2' },
    ]);
    query.mockResolvedValueOnce([{ id: 'user-2', email: 'ada@example.com', name: 'Ada' }]);

    const result = await service.list('admin-1');
    expect(result.workspaces).toEqual([
      { id: 't-2', name: 'Personal · ada@example.com', role: 'owner', viaSuperadmin: true },
    ]);
  });

  it('falls back to the owner name, then to plain "Personal", when the email is missing', async () => {
    isSuperadmin.mockResolvedValueOnce(true);
    tenantFind.mockResolvedValueOnce([
      { id: 't-2', name: 'user-2', owner_user_id: 'user-2' },
      { id: 't-3', name: 'user-3', owner_user_id: 'user-3' },
    ]);
    query.mockResolvedValueOnce([
      { id: 'user-2', email: null, name: 'Ada' },
      // user-3 has no row at all (deleted account) — no label to build.
    ]);

    const result = await service.list('admin-1');
    expect(result.workspaces.map((w) => w.name)).toEqual(['Personal', 'Personal · Ada']);
  });

  it('skips the user lookup when no foreign workspace is a personal one', async () => {
    isSuperadmin.mockResolvedValueOnce(true);
    tenantFind.mockResolvedValueOnce([{ id: 'team', name: 'Mimic', owner_user_id: null }]);

    await service.list('admin-1');
    expect(query).not.toHaveBeenCalled();
  });

  it('sorts the superadmin-only workspaces by name', async () => {
    isSuperadmin.mockResolvedValueOnce(true);
    tenantFind.mockResolvedValueOnce([
      { id: 'c', name: 'Zeta', owner_user_id: null },
      { id: 'a', name: 'Alpha', owner_user_id: null },
      { id: 'b', name: 'Mu', owner_user_id: null },
    ]);

    const result = await service.list('admin-1');
    expect(result.workspaces.map((w) => w.name)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });
});
