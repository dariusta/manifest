import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomProvider } from '../entities/custom-provider.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProviderModule } from '../routing/custom-provider/custom-provider.module';
import { OAuthModule } from '../routing/oauth/oauth.module';
import { ProxyModule } from '../routing/proxy/proxy.module';
import { RoutingCoreModule } from '../routing/routing-core/routing-core.module';
import { ConnectionTestController } from './connection-test.controller';
import { ConnectionTestService } from './connection-test.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantProvider, CustomProvider]),
    RoutingCoreModule,
    ProxyModule,
    OAuthModule,
    CustomProviderModule,
  ],
  controllers: [ConnectionTestController],
  providers: [ConnectionTestService],
})
export class ConnectionTestModule {}
