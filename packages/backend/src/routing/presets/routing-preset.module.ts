import { Module } from '@nestjs/common';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { ModelDiscoveryModule } from '../../model-discovery/model-discovery.module';
import { RoutingPresetController } from './routing-preset.controller';
import { RoutingPresetService } from './routing-preset.service';

@Module({
  imports: [RoutingCoreModule, ModelDiscoveryModule],
  controllers: [RoutingPresetController],
  providers: [RoutingPresetService],
})
export class RoutingPresetModule {}
