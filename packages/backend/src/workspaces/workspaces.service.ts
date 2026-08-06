import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Tenant } from '../entities/tenant.entity';
import { TenantMember, TenantMemberRole } from '../entities/tenant-member.entity';
import { TenantCacheService, WorkspaceRole } from '../common/services/tenant-cache.service';
import { SuperadminService } from '../common/services/superadmin.service';

export interface WorkspaceMemberView {
  userId: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
}

export interface WorkspaceListItem {
  id: string;
  name: string;
  role: WorkspaceRole;
  /**
   * True when the caller can only see this workspace because they are an
   * instance superadmin — they are not an owner or member of it. The UI badges
   * these so cross-workspace access is never invisible.
   */
  viaSuperadmin?: boolean;
}

export interface WorkspaceListView {
  workspaces: WorkspaceListItem[];
  isSuperadmin: boolean;
}

/**
 * Upper bound on the workspaces a superadmin is served in one listing. The
 * switcher is a dropdown, not a directory; an instance with more workspaces
 * than this needs a real admin page rather than a longer list.
 */
const SUPERADMIN_LIST_LIMIT = 500;

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantMember) private readonly memberRepo: Repository<TenantMember>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tenantCache: TenantCacheService,
    private readonly superadmin: SuperadminService,
  ) {}

  /**
   * The workspaces to offer in the switcher. Ordinary users get exactly what
   * they own or belong to; superadmins additionally get every other active
   * workspace on the instance, flagged so the UI can label the difference.
   */
  async list(userId: string): Promise<WorkspaceListView> {
    const mine: WorkspaceListItem[] = await this.tenantCache.listForUser(userId);
    if (!(await this.superadmin.isSuperadmin(userId))) {
      return { workspaces: mine, isSuperadmin: false };
    }

    const known = new Set(mine.map((w) => w.id));
    const all = await this.tenantRepo.find({
      where: { is_active: true },
      order: { created_at: 'ASC' },
      take: SUPERADMIN_LIST_LIMIT,
    });
    const foreign = all.filter((t) => !known.has(t.id));
    const labels = await this.personalWorkspaceLabels(foreign);

    return {
      workspaces: [
        ...mine,
        ...foreign
          .map((t) => ({
            id: t.id,
            // roleFor() resolves superadmins to 'owner' everywhere, so report
            // the role they will actually act with once switched in.
            role: 'owner' as WorkspaceRole,
            name: labels.get(t.id) ?? t.name,
            viaSuperadmin: true,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ],
      isSuperadmin: true,
    };
  }

  /**
   * Auto-created personal workspaces are named after their owner's user id, an
   * opaque string. listForUser() renders the caller's own as "Personal", but a
   * superadmin sees many at once — so label them by owner instead of showing a
   * column of identical "Personal" rows.
   */
  private async personalWorkspaceLabels(tenants: Tenant[]): Promise<Map<string, string>> {
    const personal = tenants.filter((t) => t.owner_user_id && t.name === t.owner_user_id);
    if (!personal.length) return new Map();
    const users: Array<{ id: string; email: string | null; name: string | null }> =
      await this.dataSource.query(`SELECT "id", "email", "name" FROM "user" WHERE "id" = ANY($1)`, [
        personal.map((t) => t.owner_user_id),
      ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const labels = new Map<string, string>();
    for (const tenant of personal) {
      const owner = byId.get(tenant.owner_user_id as string);
      const who = owner?.email ?? owner?.name ?? null;
      labels.set(tenant.id, who ? `Personal · ${who}` : 'Personal');
    }
    return labels;
  }

  async create(userId: string, name: string): Promise<{ id: string; name: string }> {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Workspace name is required.');
    const id = randomUUID();
    try {
      // owner_user_id stays null: the partial unique index allows one OWNED
      // tenant per user (the auto-created personal one). Extra workspaces are
      // admin-memberships instead.
      await this.tenantRepo.insert({ id, name: trimmed, owner_user_id: null, is_active: true });
    } catch {
      throw new ConflictException('A workspace with that name already exists.');
    }
    await this.memberRepo.insert({
      tenant_id: id,
      user_id: userId,
      role: 'admin',
      added_by_user_id: userId,
    });
    this.tenantCache.invalidateRole(userId, id);
    return { id, name: trimmed };
  }

  async requireRole(
    userId: string,
    tenantId: string,
    allowed: WorkspaceRole[],
  ): Promise<WorkspaceRole> {
    const role = await this.tenantCache.roleFor(userId, tenantId);
    if (!role) throw new NotFoundException('Workspace not found.');
    if (!allowed.includes(role)) {
      throw new ForbiddenException('You do not have permission to do that in this workspace.');
    }
    return role;
  }

  async members(tenantId: string): Promise<WorkspaceMemberView[]> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Workspace not found.');
    const rows = await this.memberRepo.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'ASC' },
    });
    const ids = [
      ...(tenant.owner_user_id ? [tenant.owner_user_id] : []),
      ...rows.map((r) => r.user_id),
    ];
    const users: Array<{ id: string; email: string | null; name: string | null }> = ids.length
      ? await this.dataSource.query(
          `SELECT "id", "email", "name" FROM "user" WHERE "id" = ANY($1)`,
          [ids],
        )
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const view = (userId: string, role: WorkspaceRole): WorkspaceMemberView => ({
      userId,
      email: byId.get(userId)?.email ?? null,
      name: byId.get(userId)?.name ?? null,
      role,
    });
    return [
      ...(tenant.owner_user_id ? [view(tenant.owner_user_id, 'owner')] : []),
      ...rows.map((r) => view(r.user_id, r.role)),
    ];
  }

  async addMember(
    actorUserId: string,
    tenantId: string,
    email: string,
    role: TenantMemberRole,
  ): Promise<WorkspaceMemberView> {
    await this.requireRole(actorUserId, tenantId, ['owner', 'admin']);
    if (role !== 'admin' && role !== 'member') {
      throw new BadRequestException('Role must be admin or member.');
    }
    const users: Array<{ id: string; email: string; name: string | null }> =
      await this.dataSource.query(
        `SELECT "id", "email", "name" FROM "user" WHERE lower("email") = lower($1) LIMIT 1`,
        [email.trim()],
      );
    if (!users.length) {
      throw new NotFoundException(
        'No account with that email exists on this instance yet. Ask them to sign up first.',
      );
    }
    const target = users[0];
    const existingRole = await this.tenantCache.roleFor(target.id, tenantId);
    if (existingRole) throw new ConflictException('That user is already in this workspace.');
    await this.memberRepo.insert({
      tenant_id: tenantId,
      user_id: target.id,
      role,
      added_by_user_id: actorUserId,
    });
    this.tenantCache.invalidateRole(target.id, tenantId);
    this.tenantCache.invalidate(target.id);
    return { userId: target.id, email: target.email, name: target.name, role };
  }

  async removeMember(actorUserId: string, tenantId: string, targetUserId: string): Promise<void> {
    // Members may remove themselves (leave); otherwise owner/admin required.
    if (actorUserId !== targetUserId) {
      await this.requireRole(actorUserId, tenantId, ['owner', 'admin']);
    }
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Workspace not found.');
    if (tenant.owner_user_id === targetUserId) {
      throw new BadRequestException('The workspace owner cannot be removed.');
    }
    const result = await this.memberRepo.delete({ tenant_id: tenantId, user_id: targetUserId });
    if (!result.affected) throw new NotFoundException('That user is not in this workspace.');
    this.tenantCache.invalidateRole(targetUserId, tenantId);
    this.tenantCache.invalidate(targetUserId);
  }

  async rename(actorUserId: string, tenantId: string, name: string): Promise<void> {
    await this.requireRole(actorUserId, tenantId, ['owner', 'admin']);
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Workspace name is required.');
    try {
      await this.tenantRepo.update({ id: tenantId }, { name: trimmed });
    } catch {
      throw new ConflictException('A workspace with that name already exists.');
    }
  }
}
