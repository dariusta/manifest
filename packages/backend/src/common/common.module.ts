import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from '../entities/tenant.entity';
import { Agent } from '../entities/agent.entity';
import { IngestEventBusService } from './services/ingest-event-bus.service';
import { ManifestRuntimeService } from './services/manifest-runtime.service';
import { TenantCacheService } from './services/tenant-cache.service';
import { SuperadminService } from './services/superadmin.service';
import { TenantMember } from '../entities/tenant-member.entity';
import { UserCacheInterceptor } from './interceptors/user-cache.interceptor';
import { AgentCacheInterceptor } from './interceptors/agent-cache.interceptor';
import { AgentRecordingConfigService } from './services/agent-recording-config.service';
import { RequestRecordingStorageService } from './services/request-recording-storage.service';
import { AgentListCacheInterceptor } from './interceptors/agent-list-cache.interceptor';
import { AgentListCacheService } from './services/agent-list-cache.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Tenant, Agent, TenantMember])],
  providers: [
    IngestEventBusService,
    ManifestRuntimeService,
    SuperadminService,
    TenantCacheService,
    UserCacheInterceptor,
    AgentCacheInterceptor,
    AgentListCacheInterceptor,
    AgentListCacheService,
    AgentRecordingConfigService,
    RequestRecordingStorageService,
  ],
  exports: [
    IngestEventBusService,
    ManifestRuntimeService,
    SuperadminService,
    TenantCacheService,
    UserCacheInterceptor,
    AgentCacheInterceptor,
    AgentListCacheInterceptor,
    AgentListCacheService,
    AgentRecordingConfigService,
    RequestRecordingStorageService,
  ],
})
export class CommonModule {}
