import { Body, Controller, Delete, Get, Param, Patch, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { WorkspacesService } from './workspaces.service';
import { TenantCacheService } from '../common/services/tenant-cache.service';
import { UnauthorizedException } from '@nestjs/common';

const ACTIVE_WORKSPACE_COOKIE = 'manifest_active_tenant';

@Controller('api/v1/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly tenantCache: TenantCacheService,
  ) {}

  private userId(ctx: TenantContext): string {
    if (!ctx.userId) throw new UnauthorizedException('A signed-in session is required.');
    return ctx.userId;
  }

  @Get()
  async list(@TenantCtx() ctx: TenantContext) {
    const { workspaces, isSuperadmin } = await this.workspaces.list(this.userId(ctx));
    return {
      workspaces,
      activeTenantId: ctx.tenantId,
      activeRole: ctx.role ?? 'owner',
      isSuperadmin,
    };
  }

  @Post()
  create(@TenantCtx() ctx: TenantContext, @Body() body: { name?: string }) {
    return this.workspaces.create(this.userId(ctx), body?.name ?? '');
  }

  @Post(':id/switch')
  async switch(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 404s when the user has no access — never sets a cookie for a foreign tenant.
    await this.workspaces.requireRole(this.userId(ctx), id, ['owner', 'admin', 'member']);
    res.cookie(ACTIVE_WORKSPACE_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    return { activeTenantId: id };
  }

  @Get(':id/members')
  async members(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
    await this.workspaces.requireRole(this.userId(ctx), id, ['owner', 'admin', 'member']);
    return { members: await this.workspaces.members(id) };
  }

  @Post(':id/members')
  addMember(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { email?: string; role?: 'admin' | 'member' },
  ) {
    return this.workspaces.addMember(
      this.userId(ctx),
      id,
      body?.email ?? '',
      body?.role ?? 'member',
    );
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    await this.workspaces.removeMember(this.userId(ctx), id, targetUserId);
    return { ok: true };
  }

  @Patch(':id')
  async rename(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ) {
    await this.workspaces.rename(this.userId(ctx), id, body?.name ?? '');
    return { ok: true };
  }
}
