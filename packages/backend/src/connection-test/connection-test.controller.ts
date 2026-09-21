import { Controller, Param, Post } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { ConnectionTestService } from './connection-test.service';

/**
 * Live "does this account actually work" check for one provider connection.
 *
 * Sits beside `api/v1/providers/plan-usage` rather than on the
 * `TenantProvidersController`, which is documented CONFIG ONLY and must stay
 * cheap — this route deliberately makes an upstream network call.
 */
@Controller('api/v1/providers/connection-test')
export class ConnectionTestController {
  constructor(private readonly connectionTest: ConnectionTestService) {}

  @Post(':connectionId')
  async test(@TenantCtx() ctx: TenantContext, @Param('connectionId') connectionId: string) {
    return this.connectionTest.test(ctx.tenantId, connectionId);
  }
}
