import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubscriptionHealthCronService } from './subscription-health-cron.service';
import { ConnectionTestService } from '../../connection-test/connection-test.service';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { Tenant } from '../../entities/tenant.entity';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService } from './notification-log.service';

function connection(overrides: Partial<TenantProvider> = {}): TenantProvider {
  return {
    id: 'conn-1',
    tenant_id: 'tenant-1',
    created_by_user_id: null,
    agent_id: null,
    provider: 'anthropic',
    api_key_encrypted: 'enc',
    key_prefix: null,
    auth_type: 'subscription',
    label: 'Darius Main Plan',
    priority: 0,
    region: null,
    is_active: true,
    connected_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    manual_usage_limit_usd: null,
    cached_models: [{ id: 'claude-opus-4-1' } as never],
    models_fetched_at: null,
    cached_quota_report: null,
    cached_quota_at: null,
    ...overrides,
  };
}

describe('SubscriptionHealthCronService', () => {
  let service: SubscriptionHealthCronService;
  let mockFind: jest.Mock;
  let mockTest: jest.Mock;
  let mockSendHealthAlert: jest.Mock;
  let mockHasAlreadySent: jest.Mock;
  let mockInsertLog: jest.Mock;
  let mockResolveRecipientEmail: jest.Mock;
  let mockGetFullConfig: jest.Mock;

  beforeEach(async () => {
    mockFind = jest.fn();
    mockTest = jest.fn();
    mockSendHealthAlert = jest.fn().mockResolvedValue(true);
    mockHasAlreadySent = jest.fn().mockResolvedValue(false);
    mockInsertLog = jest.fn().mockResolvedValue(undefined);
    mockResolveRecipientEmail = jest.fn().mockResolvedValue('owner@test.com');
    mockGetFullConfig = jest.fn().mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionHealthCronService,
        { provide: getRepositoryToken(TenantProvider), useValue: { find: mockFind } },
        { provide: getRepositoryToken(Tenant), useValue: {} },
        { provide: ConnectionTestService, useValue: { test: mockTest } },
        {
          provide: NotificationEmailService,
          useValue: { sendSubscriptionHealthAlert: mockSendHealthAlert },
        },
        {
          provide: EmailProviderConfigService,
          useValue: { getFullConfig: mockGetFullConfig },
        },
        {
          provide: NotificationLogService,
          useValue: {
            hasAlreadySent: mockHasAlreadySent,
            insertLog: mockInsertLog,
            resolveRecipientEmail: mockResolveRecipientEmail,
          },
        },
        {
          provide: ManifestRuntimeService,
          useValue: { getAuthBaseUrl: () => 'http://localhost:3001' },
        },
      ],
    }).compile();

    service = module.get(SubscriptionHealthCronService);
  });

  it('returns 0 when there are no subscription connections', async () => {
    mockFind.mockResolvedValue([]);
    await expect(service.checkSubscriptionHealth()).resolves.toBe(0);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it('clears the streak and stays silent on ok', async () => {
    mockFind.mockResolvedValue([connection()]);
    mockTest.mockResolvedValue({ status: 'ok', message: 'Replied in 100ms.' });
    await expect(service.checkSubscriptionHealth()).resolves.toBe(0);
    expect(mockSendHealthAlert).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });

  it('alerts on needs_reconnect with the providers URL', async () => {
    mockFind.mockResolvedValue([connection()]);
    mockTest.mockResolvedValue({
      status: 'needs_reconnect',
      message: 'Stored credential expired.',
    });
    await expect(service.checkSubscriptionHealth()).resolves.toBe(1);
    expect(mockSendHealthAlert).toHaveBeenCalledTimes(1);
    const [to, props] = mockSendHealthAlert.mock.calls[0];
    expect(to).toBe('owner@test.com');
    expect(props.provider).toBe('anthropic');
    expect(props.label).toBe('Darius Main Plan');
    expect(props.status).toBe('needs_reconnect');
    expect(props.providersUrl).toBe('http://localhost:3001/providers/subscriptions');
    expect(props.consecutiveFailures).toBe(1);
  });

  it('dedupes repeat alerts for the same connection on the same day', async () => {
    mockFind.mockResolvedValue([connection()]);
    mockTest.mockResolvedValue({ status: 'failed', message: 'Provider 500.' });
    mockHasAlreadySent.mockResolvedValue(true);
    await expect(service.checkSubscriptionHealth()).resolves.toBe(0);
    expect(mockSendHealthAlert).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });

  it('tracks consecutive failures across runs', async () => {
    mockFind.mockResolvedValue([connection()]);
    mockTest.mockResolvedValue({ status: 'failed', message: 'Provider 500.' });
    await service.checkSubscriptionHealth();
    await service.checkSubscriptionHealth();
    expect(mockSendHealthAlert).toHaveBeenCalledTimes(2);
    expect(mockSendHealthAlert.mock.calls[1][1].consecutiveFailures).toBe(2);
  });

  it('skips BYOK rows entirely', async () => {
    // The repository query filters auth_type='subscription'; an empty result
    // (all rows are api_key) means no tests and no alerts.
    mockFind.mockResolvedValue([]);
    await expect(service.checkSubscriptionHealth('tenant-1')).resolves.toBe(0);
    expect(mockFind).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', auth_type: 'subscription', is_active: true },
    });
  });

  it('skips the alert when no recipient email resolves', async () => {
    mockFind.mockResolvedValue([connection()]);
    mockTest.mockResolvedValue({ status: 'needs_reconnect', message: 'Expired.' });
    mockResolveRecipientEmail.mockResolvedValue(null);
    await expect(service.checkSubscriptionHealth()).resolves.toBe(0);
    expect(mockSendHealthAlert).not.toHaveBeenCalled();
  });

  it('survives a single exploding connection test', async () => {
    mockFind.mockResolvedValue([connection({ id: 'boom' }), connection({ id: 'fine' })]);
    mockTest
      .mockRejectedValueOnce(new Error('DB gone'))
      .mockResolvedValueOnce({ status: 'needs_reconnect', message: 'Expired.' });
    await expect(service.checkSubscriptionHealth()).resolves.toBe(1);
  });
});
