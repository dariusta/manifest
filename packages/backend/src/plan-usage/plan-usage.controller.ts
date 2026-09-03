import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { ManualUsageLimitDto } from './plan-usage.dto';
import { PlanUsageService } from './plan-usage.service';

@Controller('api/v1/providers/plan-usage')
export class PlanUsageController {
  constructor(private readonly planUsage: PlanUsageService) {}

  @Get()
  async getPlanUsage(
    @TenantCtx() ctx: TenantContext,
    @Query('connectionId') connectionId?: string,
  ) {
    return {
      connections: await this.planUsage.getPlanUsage(
        ctx.tenantId,
        connectionId?.trim() || undefined,
      ),
    };
  }

  @Patch(':connectionId/manual-limit')
  async setManualLimit(
    @TenantCtx() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
    @Body() body: ManualUsageLimitDto,
  ) {
    const connection = await this.planUsage.setManualLimit(
      ctx.tenantId,
      connectionId,
      body.limitUsd,
    );
    return { connectionId: connection.id, limitUsd: Number(connection.manual_usage_limit_usd) };
  }

  @Delete(':connectionId/manual-limit')
  async clearManualLimit(
    @TenantCtx() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
  ) {
    const connection = await this.planUsage.setManualLimit(ctx.tenantId, connectionId, null);
    return { connectionId: connection.id, limitUsd: null };
  }
}
