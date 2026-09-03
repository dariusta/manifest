import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMessage } from '../entities/agent-message.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { RoutingCoreModule } from '../routing/routing-core/routing-core.module';
import { PlanUsageController } from './plan-usage.controller';
import { PlanUsageService } from './plan-usage.service';
import { ProviderUsageAdapterRegistry } from './provider-usage-adapters';

@Module({
  imports: [TypeOrmModule.forFeature([TenantProvider, AgentMessage]), RoutingCoreModule],
  controllers: [PlanUsageController],
  providers: [PlanUsageService, ProviderUsageAdapterRegistry],
})
export class PlanUsageModule {}
