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

export interface WorkspaceMemberView {
  userId: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
}

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantMember) private readonly memberRepo: Repository<TenantMember>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tenantCache: TenantCacheService,
  ) {}

  list(userId: string) {
    return this.tenantCache.listForUser(userId);
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
