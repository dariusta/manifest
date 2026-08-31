import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../../common/decorators/tenant-context.decorator';
import { ResolveAgentService } from '../../routing-core/resolve-agent.service';
import { ProviderService } from '../../routing-core/provider.service';
import { AnthropicOauthExchangeError, AnthropicOauthService } from './anthropic-oauth.service';
import { optionalTrimmedStringQuery } from '../core/query-params';

@Controller('api/v1/oauth/anthropic')
export class AnthropicOauthController {
  private readonly logger = new Logger(AnthropicOauthController.name);

  constructor(
    private readonly oauthService: AnthropicOauthService,
    private readonly resolveAgent: ResolveAgentService,
    private readonly providerService: ProviderService,
  ) {}

  /**
   * Generate the Anthropic OAuth authorize URL with PKCE. The frontend opens
   * the returned URL in a new tab; Anthropic's redirect page then displays
   * the authorization code for the user to paste into the SPA.
   */
  @Post('authorize')
  async authorize(@Query('agentName') agentName: string, @TenantCtx() ctx: TenantContext) {
    if (!agentName) {
      throw new HttpException('agentName query parameter is required', HttpStatus.BAD_REQUEST);
    }
    const agent = await this.resolveAgent.resolve(ctx.tenantId, agentName);
    return this.oauthService.generateAuthorizationUrl(agent.id, agent.tenant_id);
  }

  /**
   * Exchange the pasted authorization payload (`<code>#<state>` or just the
   * code with state in the body) for an OAuth token blob.
   */
  @Post('exchange')
  async exchange(
    @Query('agentName') agentName: string,
    @Body('code') code: string,
    @Body('state') state: string,
    @TenantCtx() ctx: TenantContext,
  ) {
    if (!agentName) {
      throw new HttpException('agentName query parameter is required', HttpStatus.BAD_REQUEST);
    }
    if (!code) {
      throw new HttpException('code is required', HttpStatus.BAD_REQUEST);
    }
    // Resolve the agent so unknown agents still 404 even if state is valid.
    const agent = await this.resolveAgent.resolve(ctx.tenantId, agentName);
    try {
      await this.oauthService.exchangeCode(code, state, agent.id, agent.tenant_id, ctx.userId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token exchange failed';
      this.logger.error(`Anthropic OAuth exchange failed: ${message}`);
      throw new HttpException(
        message,
        err instanceof AnthropicOauthExchangeError ? err.status : HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Hydrates the SPA after a tab/modal close: returns the active pending
   * state for an agent if a sign-in flow was started but not yet exchanged,
   * so the paste-code field can be re-rendered without restarting the dance.
   */
  @Get('pending')
  async pending(@Query('agentName') agentName: string, @TenantCtx() ctx: TenantContext) {
    if (!agentName) {
      throw new HttpException('agentName query parameter is required', HttpStatus.BAD_REQUEST);
    }
    const agent = await this.resolveAgent.resolve(ctx.tenantId, agentName);
    return (
      (await this.oauthService.findPendingForAgent(agent.id, agent.tenant_id)) ?? { state: null }
    );
  }

  /**
   * Reveal the current bearer credential for one connected account.
   *
   * Anthropic's pasted OAuth authorization code is single-use and is not
   * retained after exchange. The account detail UI calls this endpoint to
   * show the useful equivalent: the current access token, refreshed first
   * when necessary. Keep this response out of every intermediary cache.
   */
  @Get('credential')
  @Header('Cache-Control', 'no-store')
  async credential(
    @Query('agentName') agentName: string,
    @Query('label') label: string | string[] | undefined,
    @TenantCtx() ctx: TenantContext,
  ) {
    if (!agentName) {
      throw new HttpException('agentName query parameter is required', HttpStatus.BAD_REQUEST);
    }
    const keyLabel = optionalTrimmedStringQuery(label, 'label');
    const agent = await this.resolveAgent.resolve(ctx.tenantId, agentName);
    const rawCredential = await this.providerService.getFreshSubscriptionCredential(
      agent.tenant_id,
      'anthropic',
      keyLabel,
    );
    if (!rawCredential) {
      throw new HttpException('Anthropic account credential not found', HttpStatus.NOT_FOUND);
    }
    const authorizationCode = await this.oauthService.unwrapToken(
      rawCredential,
      agent.id,
      agent.tenant_id,
      keyLabel,
    );
    if (!authorizationCode) {
      throw new HttpException(
        'Anthropic account credential is unavailable. Reconnect the account and try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { authorizationCode };
  }

  /** Disconnect the Anthropic subscription provider for an agent. */
  @Post('revoke')
  async revoke(
    @Query('agentName') agentName: string,
    @Query('label') label: string | string[] | undefined,
    @TenantCtx() ctx: TenantContext,
  ) {
    if (!agentName) {
      throw new HttpException('agentName query parameter is required', HttpStatus.BAD_REQUEST);
    }
    const keyLabel = optionalTrimmedStringQuery(label, 'label');
    const agent = await this.resolveAgent.resolve(ctx.tenantId, agentName);
    const { notifications } = await this.providerService.removeProvider(
      agent.id,
      agent.tenant_id,
      'anthropic',
      'subscription',
      keyLabel,
    );
    return { ok: true, notifications };
  }
}
