import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConnectionTestService } from '../../connection-test/connection-test.service';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { Tenant } from '../../entities/tenant.entity';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService, formatNotificationTimestamp } from './notification-log.service';

/**
 * Subscription-relink watchdog.
 *
 * Migration-free by design: no health columns on `tenant_providers`.
 * Consecutive-failure counts live in memory (best-effort — a restart resets
 * the streak, and the next failing run re-alerts, which is the safe
 * direction). Per-run alert dedupe reuses the existing `notification_logs`
 * table with a synthetic `subscription-health` rule id + a daily period, so
 * a still-broken account produces at most one email per day rather than one
 * per cron tick.
 *
 * Only `subscription` auth-type connections are checked — API-key (BYOK)
 * rows have no relink action, so alerting on them would just be noise.
 */
@Injectable()
export class SubscriptionHealthCronService {
  private readonly logger = new Logger(SubscriptionHealthCronService.name);

  /**
   * connectionId -> consecutive failing runs. Cleared on the first `ok` or
   * `untestable` result. In-memory on purpose: no migration, and a restart
   * can only cause a re-alert, never a missed one.
   */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @Inject(forwardRef(() => ConnectionTestService))
    private readonly connectionTest: ConnectionTestService,
    private readonly emailService: NotificationEmailService,
    private readonly emailProviderConfigService: EmailProviderConfigService,
    private readonly runtime: ManifestRuntimeService,
    private readonly notificationLog: NotificationLogService,
  ) {}

  /**
   * Hourly sweep: test every active subscription connection, alert once per
   * day per still-broken account. Accepts an optional tenant id so a single
   * tenant can be swept on demand (same pattern as the threshold cron).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkSubscriptionHealth(tenantId?: string): Promise<number> {
    const connections = await this.providerRepo.find({
      where: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        auth_type: 'subscription',
        is_active: true,
      },
    });
    if (!connections.length) return 0;

    let alerted = 0;
    for (const connection of connections) {
      try {
        const result = await this.connectionTest.test(connection.tenant_id, connection.id);
        if (result.status === 'ok' || result.status === 'untestable') {
          this.consecutiveFailures.delete(connection.id);
          continue;
        }
        const streak = (this.consecutiveFailures.get(connection.id) ?? 0) + 1;
        this.consecutiveFailures.set(connection.id, streak);
        const sent = await this.maybeAlert(connection, result.status, result.message, streak);
        if (sent) alerted++;
      } catch (err) {
        this.logger.error(`Subscription health check failed for ${connection.id}: ${err}`);
      }
    }
    return alerted;
  }

  /**
   * Alert at most once per calendar day per connection: the synthetic rule id
   * `subscription-health:<connectionId>` plus today's date as the period
   * reuses the notification_logs unique (rule_id, period_start) constraint
   * as the dedupe lock. First failure alerts immediately — a dead
   * subscription is actionable on run one, not run three.
   */
  private async maybeAlert(
    connection: TenantProvider,
    status: 'needs_reconnect' | 'failed',
    message: string,
    streak: number,
  ): Promise<boolean> {
    const now = formatNotificationTimestamp();
    const today = now.slice(0, 10);
    const ruleId = `subscription-health:${connection.id}`;
    if (await this.notificationLog.hasAlreadySent(ruleId, today)) return false;

    const fullConfig = await this.emailProviderConfigService.getFullConfig(connection.tenant_id);
    const email = await this.notificationLog.resolveRecipientEmail(
      connection.tenant_id,
      fullConfig?.notificationEmail,
    );
    if (!email) {
      this.logger.warn(
        `No email found for tenant ${connection.tenant_id}, skipping subscription-health alert for ${connection.id}`,
      );
      return false;
    }

    await this.notificationLog.insertLog({
      ruleId,
      periodStart: today,
      periodEnd: today,
      actualValue: streak,
      thresholdValue: 1,
      metricType: 'subscription_health',
      agentName: 'subscription-health',
      sentAt: now,
    });

    const testedAt = new Date().toISOString();
    return this.emailService.sendSubscriptionHealthAlert(
      email,
      {
        provider: connection.provider,
        label: connection.label,
        status,
        message,
        testedAt,
        timestamp: now,
        providersUrl: `${this.runtime.getAuthBaseUrl()}/providers/subscriptions`,
        consecutiveFailures: streak,
      },
      fullConfig ?? undefined,
    );
  }
}
