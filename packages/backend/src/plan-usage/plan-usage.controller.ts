import { Controller, Get, Query } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
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
}
