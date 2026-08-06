import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Tenant } from '../../entities/tenant.entity';
import { TenantMember, TenantMemberRole } from '../../entities/tenant-member.entity';
import { TtlFifoCache } from '../utils/ttl-fifo-cache';
import { SuperadminService } from './superadmin.service';

export type WorkspaceRole = 'owner' | TenantMemberRole;

/**
 * The ONE place user→tenant resolution happens. Everything downstream is
 * scoped by tenantId; a future team plan only has to swap the lookup here
 * (owner_user_id → membership table) and nothing else moves.
 */
@Injectable()
export class TenantCacheService {
  private readonly cache = new TtlFifoCache<string, string | null>({
    maxEntries: 5_000,
    ttlMs: 300_000,
  });

  // userId:tenantId → role ('none' = checked and not a member; cached briefly
  // so a revoked member loses access within the TTL). 'unknown' = the lookup
  // failed and must NOT be memoized.
  private readonly roleCache = new TtlFifoCache<string, WorkspaceRole | 'none' | 'unknown'>({
    maxEntries: 10_000,
    ttlMs: 60_000,
  });

  // actingTenantId → team tenant ids whose providers it may borrow. Cached
  // briefly so a membership grant/revoke reflects in shared-provider access
  // within the TTL (mirrors roleCache; both are membership-derived).
  private readonly sharedTenantsCache = new TtlFifoCache<string, string[]>({
    maxEntries: 10_000,
    ttlMs: 60_000,
  });

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantMember)
    private readonly memberRepo: Repository<TenantMember>,
    private readonly superadmin: SuperadminService,
  ) {}

  async resolve(userId: string): Promise<string | null> {
    // Memoize only a real tenant id, never the "no tenant yet" (null) result.
    // Tenants are created lazily (first agent / playground / provider), and the
    // create-agent request's own guard resolves the tenant BEFORE its handler
    // creates it. Caching that null for the full TTL made every tenant-lookup
    // endpoint — notably connecting a provider — return 404 "Tenant not found"
    // for up to 5 minutes after a user created their first agent. Skipping the
    // negative cache keeps the hot path fast while letting the very next request
    // observe a freshly created tenant.
    return this.cache.resolve(
      userId,
      async (uid) => {
        const tenant = await this.tenantRepo.findOne({ where: { owner_user_id: uid } });
        if (tenant) return tenant.id;
        // No owned tenant: fall back to the oldest workspace membership so
        // invited-only users land somewhere instead of a null tenant.
        const membership = await this.memberRepo.findOne({
          where: { user_id: uid },
          order: { created_at: 'ASC' },
        });
        return membership?.tenant_id ?? null;
      },
      (tenantId) => tenantId !== null,
    );
  }

  /**
   * The user's role in a specific tenant: 'owner' via tenants.owner_user_id
   * (implicit — owners have no tenant_members row), else the membership row's
   * role, else null.
   *
   * Instance superadmins resolve to 'owner' in every ACTIVE workspace. Granting
   * the existing top role here — rather than adding a fourth role to
   * WorkspaceRole — is what makes this change small: every requireRole() check
   * downstream keeps its current allow-list and simply passes. Inactive tenants
   * still resolve to null, so superadmin cannot resurrect a disabled workspace.
   */
  async roleFor(userId: string, tenantId: string): Promise<WorkspaceRole | null> {
    const cached = await this.roleCache.resolve(
      `${userId}:${tenantId}`,
      async () => {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant || !tenant.is_active) return 'none';
        if (tenant.owner_user_id === userId) return 'owner';
        const superadmin = await this.superadmin.check(userId);
        // A failed superadmin lookup must not fall through to 'none': that
        // answer would be cached for the full TTL, locking a real superadmin
        // out of every foreign workspace long after the database recovered.
        // Propagate the uncertainty instead — this request fails closed, and
        // the next one re-checks.
        if (superadmin === 'unknown') return 'unknown';
        if (superadmin) return 'owner';
        const member = await this.memberRepo.findOne({
          where: { tenant_id: tenantId, user_id: userId },
        });
        return member ? member.role : 'none';
      },
      (value) => value !== 'unknown',
    );
    return cached === 'none' || cached === 'unknown' ? null : cached;
  }

  /**
   * Resolve the tenant to scope this request by. When the client requested a
   * specific workspace (cookie), honor it only if the user actually has
   * access; otherwise fall back to the default resolution.
   */
  async resolveActive(
    userId: string,
    requestedTenantId: string | null,
  ): Promise<{ tenantId: string | null; role: WorkspaceRole | null }> {
    if (requestedTenantId) {
      const role = await this.roleFor(userId, requestedTenantId);
      if (role) return { tenantId: requestedTenantId, role };
    }
    const tenantId = await this.resolve(userId);
    if (!tenantId) return { tenantId: null, role: null };
    return { tenantId, role: await this.roleFor(userId, tenantId) };
  }

  /** All workspaces the user can access (owned + memberships). */
  async listForUser(
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: WorkspaceRole }>> {
    const owned = await this.tenantRepo.find({ where: { owner_user_id: userId } });
    const memberships = await this.memberRepo.find({
      where: { user_id: userId },
      order: { created_at: 'ASC' },
    });
    const memberTenants = memberships.length
      ? await this.tenantRepo
          .createQueryBuilder('t')
          .where('t.id IN (:...ids)', { ids: memberships.map((m) => m.tenant_id) })
          .andWhere('t.is_active = true')
          .getMany()
      : [];
    const roleByTenant = new Map(memberships.map((m) => [m.tenant_id, m.role]));
    // Auto-created personal tenants mirror the user id as their name — an
    // opaque string nobody chose. Show those as "Personal" in the UI.
    const displayName = (t: Tenant) =>
      t.owner_user_id && t.name === t.owner_user_id ? 'Personal' : t.name;
    return [
      ...owned.map((t) => ({ id: t.id, name: displayName(t), role: 'owner' as WorkspaceRole })),
      ...memberTenants.map((t) => ({
        id: t.id,
        name: t.name,
        role: (roleByTenant.get(t.id) ?? 'member') as WorkspaceRole,
      })),
    ];
  }

  /**
   * Team workspaces whose providers the given acting tenant may borrow.
   *
   * Implements "team shares all → members": a personal workspace (one with an
   * `owner_user_id`) may use the providers of every team workspace its owner is
   * a member of. Returns ONLY the borrowed (foreign) tenant ids — the acting
   * tenant is unioned in by the caller. Team/shared workspaces (no owner) borrow
   * from no one, so members can't leak one team's keys into another team.
   */
  async sharedProviderTenantIds(actingTenantId: string): Promise<string[]> {
    return this.sharedTenantsCache.resolve(actingTenantId, async (id) => {
      const tenant = await this.tenantRepo.findOne({ where: { id } });
      const ownerUserId = tenant?.owner_user_id;
      if (!ownerUserId) return [];
      const memberships = await this.memberRepo.find({ where: { user_id: ownerUserId } });
      const ids = memberships.map((m) => m.tenant_id).filter((tid) => tid !== id);
      if (ids.length === 0) return [];
      const active = await this.tenantRepo
        .createQueryBuilder('t')
        .select('t.id', 'id')
        .where('t.id IN (:...ids)', { ids })
        .andWhere('t.is_active = true')
        .getRawMany<{ id: string }>();
      return active.map((r) => r.id);
    });
  }

  /** Drop a cached role so grants/revocations apply on the next request. */
  invalidateRole(userId: string, tenantId: string): void {
    this.roleCache.invalidate(`${userId}:${tenantId}`);
  }

  /**
   * Drop cached shared-provider resolution for a tenant so a membership change
   * reflects immediately. Membership grants/revokes affect the OWNER's personal
   * workspace, so callers pass that tenant id.
   */
  invalidateSharedProviders(actingTenantId: string): void {
    this.sharedTenantsCache.invalidate(actingTenantId);
  }

  /**
   * Resolve the user's tenant, creating it when missing. Used by mutation
   * paths that must work before the first agent exists (playground, custom
   * providers). Insert races resolve to the surviving row.
   */
  async ensureForUser(userId: string): Promise<string> {
    const existing = await this.resolve(userId);
    if (existing) return existing;

    const id = randomUUID();
    try {
      await this.tenantRepo.insert({ id, name: userId, owner_user_id: userId, is_active: true });
      this.cache.invalidate(userId);
      return id;
    } catch (err) {
      // Unique index on owner_user_id: a concurrent request may have created
      // it first — reuse the winner's row. Any other failure is a real error
      // (not a race): re-throw it rather than masking it.
      this.cache.invalidate(userId);
      const raced = await this.tenantRepo.findOne({ where: { owner_user_id: userId } });
      if (raced) return raced.id;
      throw err;
    }
  }

  /** Remove a cached entry so the next resolve() re-hits the DB. */
  invalidate(userId: string): void {
    this.cache.invalidate(userId);
  }
}
