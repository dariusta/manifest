import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TenantCtx, type TenantContext } from '../../common/decorators/tenant-context.decorator';
import { RoutingPresetService } from './routing-preset.service';

class CreatePresetDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsString() @MinLength(1) @MaxLength(256) sourceAgentName!: string;
}
class UpdatePresetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}
@Controller('api/v1/routing-presets')
export class RoutingPresetController {
  constructor(private readonly presets: RoutingPresetService) {}
  @Get() list(@TenantCtx() ctx: TenantContext) {
    return this.presets.list(ctx.tenantId);
  }
  @Post() create(@TenantCtx() ctx: TenantContext, @Body() body: CreatePresetDto) {
    return this.presets.create(ctx.tenantId, body.name, body.sourceAgentName);
  }
  @Patch(':id') update(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdatePresetDto,
  ) {
    return this.presets.update(ctx.tenantId, id, body);
  }
  @Delete(':id') delete(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
    return this.presets.delete(ctx.tenantId, id);
  }
  @Post(':id/apply/:agentName') apply(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('agentName') name: string,
  ) {
    return this.presets.apply(ctx.tenantId, id, name);
  }
}
