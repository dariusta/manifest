import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';
import { ThresholdAlertEmail, ThresholdAlertProps } from '../emails/threshold-alert';
import {
  SubscriptionHealthAlertEmail,
  SubscriptionHealthAlertProps,
} from '../emails/subscription-health-alert';
import { sendEmail } from './email-providers/send-email';
import { createProvider } from './email-providers/resolve-provider';
import type { EmailProviderConfig } from './email-providers/email-provider.interface';
import type { EmailProviderFullConfig } from './email-provider-config.service';

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);
  private readonly fromEmail: string;

  constructor(private readonly configService: ConfigService) {
    this.fromEmail =
      this.configService.get<string>('app.emailFrom') ||
      this.configService.get<string>('app.notificationFromEmail', 'noreply@manifest.build');
  }

  async sendThresholdAlert(
    to: string,
    props: ThresholdAlertProps,
    providerConfig?: { provider: string; apiKey: string; domain: string | null },
  ): Promise<boolean> {
    const element = ThresholdAlertEmail(props);
    const html = await render(element);
    const text = await render(element, { plainText: true });
    const subject =
      props.alertType === 'soft'
        ? `Warning: ${props.agentName} exceeded ${props.metricType} threshold`
        : `Blocked: ${props.agentName} reached ${props.metricType} limit`;

    if (providerConfig) {
      const defaultFrom = this.fromEmail;
      const from = providerConfig.domain
        ? `Manifest <noreply@${providerConfig.domain}>`
        : `Manifest <${defaultFrom}>`;
      const config: EmailProviderConfig = {
        provider: providerConfig.provider as EmailProviderConfig['provider'],
        apiKey: providerConfig.apiKey,
        domain: providerConfig.domain ?? undefined,
      };
      const provider = createProvider(config);
      const sent = await provider.send({ to, subject, html, text, from });
      if (sent) {
        this.logger.log(`Threshold alert sent to ${to} for agent ${props.agentName}`);
      }
      return sent;
    }

    const from = `Manifest <${this.fromEmail}>`;
    const sent = await sendEmail({ to, subject, html, text, from });
    if (sent) {
      this.logger.log(`Threshold alert sent to ${to} for agent ${props.agentName}`);
    }
    return sent;
  }

  /**
   * Subscription health alert: one linked account needs a relink (or keeps
   * failing its periodic check). Mirrors the threshold mail path so tenant
   * email config and fallbacks behave identically.
   */
  async sendSubscriptionHealthAlert(
    to: string,
    props: SubscriptionHealthAlertProps,
    providerConfig?: EmailProviderFullConfig,
  ): Promise<boolean> {
    const element = SubscriptionHealthAlertEmail(props);
    const html = await render(element);
    const text = await render(element, { plainText: true });
    const subject = `Manifest: ${props.provider} account “${props.label}” needs attention`;

    if (providerConfig) {
      const defaultFrom = this.fromEmail;
      const from = providerConfig.domain
        ? `Manifest <noreply@${providerConfig.domain}>`
        : `Manifest <${defaultFrom}>`;
      // Credential stays inside EmailProviderConfigService: the cron passes
      // the full config in, and the sender is built from its fields here
      // (mirrors the threshold path's tenant branch).
      const sent = await this.sendWithTenantConfig(to, subject, html, text, from, providerConfig);
      if (sent) {
        this.logger.log(
          `Subscription health alert sent to ${to} for ${props.provider}/${props.label}`,
        );
      }
      return sent;
    }

    const from = `Manifest <${this.fromEmail}>`;
    const sent = await sendEmail({ to, subject, html, text, from });
    if (sent) {
      this.logger.log(
        `Subscription health alert sent to ${to} for ${props.provider}/${props.label}`,
      );
    }
    return sent;
  }

  /**
   * Build the tenant sender from the full tenant email config the cron
   * passes in (mirrors the threshold path's tenant branch). The config
   * service decrypts; the provider factory just receives the fields.
   */
  private sendWithTenantConfig(
    to: string,
    subject: string,
    html: string,
    text: string,
    from: string,
    cfg: EmailProviderFullConfig,
  ): Promise<boolean> {
    const provider = createProvider({
      provider: cfg.provider as EmailProviderConfig['provider'],
      domain: cfg.domain ?? undefined,
      ...this.pickCredential(cfg),
    });
    return provider.send({ to, subject, html, text, from });
  }

  /**
   * Forward the decrypted credential the config service already resolved.
   * Narrowed to the provider factory's credential field so nothing else
   * leaks across the seam.
   */
  private pickCredential(cfg: EmailProviderFullConfig): Pick<EmailProviderConfig, 'apiKey'> {
    return { apiKey: cfg.apiKey };
  }
}
