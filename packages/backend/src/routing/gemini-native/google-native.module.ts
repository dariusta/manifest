import { Module } from '@nestjs/common';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { OAuthModule } from '../oauth/oauth.module';
import { OtlpModule } from '../../otlp/otlp.module';
import { GoogleNativeController } from './google-native.controller';
import { GoogleNativeService } from './google-native.service';

/**
 * The Gemini-native passthrough surfaces (Files API + agentic mode).
 *
 * Separate from `ProxyModule` because nothing here is routed: it needs
 * credentials (`RoutingCoreModule`, `OAuthModule`) and caller auth
 * (`OtlpModule` → `AgentKeyAuthGuard`), but none of the scoring, tier
 * resolution, fallback or recording machinery the proxy is built around.
 */
@Module({
  imports: [RoutingCoreModule, OAuthModule, OtlpModule],
  controllers: [GoogleNativeController],
  providers: [GoogleNativeService],
  exports: [GoogleNativeService],
})
export class GoogleNativeModule {}
