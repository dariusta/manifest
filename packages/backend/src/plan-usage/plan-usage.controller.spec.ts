import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PlanUsageController } from './plan-usage.controller';

describe('PlanUsageController', () => {
  it('exposes GET /api/v1/providers/plan-usage and forwards tenant plus optional refresh ID', async () => {
    const service = {
      getPlanUsage: jest.fn().mockResolvedValue([{ tenant_provider_id: 'tp-1' }]),
      setManualLimit: jest.fn(),
    };
    const controller = new PlanUsageController(service as never);

    await expect(
      controller.getPlanUsage({ tenantId: 'tenant-1', userId: 'user-1' }, 'tp-1'),
    ).resolves.toEqual({ connections: [{ tenant_provider_id: 'tp-1' }] });
    expect(service.getPlanUsage).toHaveBeenCalledWith('tenant-1', 'tp-1');
    expect(Reflect.getMetadata(PATH_METADATA, PlanUsageController)).toBe(
      'api/v1/providers/plan-usage',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, PlanUsageController.prototype.getPlanUsage)).toBe(
      RequestMethod.GET,
    );
  });

  it('sets and clears a manual allowance through tenant-scoped endpoints', async () => {
    const service = {
      getPlanUsage: jest.fn(),
      setManualLimit: jest
        .fn()
        .mockResolvedValueOnce({ id: 'tp-1', manual_usage_limit_usd: '75.00' })
        .mockResolvedValueOnce({ id: 'tp-1', manual_usage_limit_usd: null }),
    };
    const controller = new PlanUsageController(service as never);
    const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

    await expect(controller.setManualLimit(ctx, 'tp-1', { limitUsd: 75 })).resolves.toEqual({
      connectionId: 'tp-1',
      limitUsd: 75,
    });
    await expect(controller.clearManualLimit(ctx, 'tp-1')).resolves.toEqual({
      connectionId: 'tp-1',
      limitUsd: null,
    });
    expect(service.setManualLimit).toHaveBeenNthCalledWith(1, 'tenant-1', 'tp-1', 75);
    expect(service.setManualLimit).toHaveBeenNthCalledWith(2, 'tenant-1', 'tp-1', null);
    expect(Reflect.getMetadata(METHOD_METADATA, PlanUsageController.prototype.setManualLimit)).toBe(
      RequestMethod.PATCH,
    );
    expect(
      Reflect.getMetadata(METHOD_METADATA, PlanUsageController.prototype.clearManualLimit),
    ).toBe(RequestMethod.DELETE);
  });
});
