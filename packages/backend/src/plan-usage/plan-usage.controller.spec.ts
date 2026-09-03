import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PlanUsageController } from './plan-usage.controller';

describe('PlanUsageController', () => {
  it('exposes GET /api/v1/providers/plan-usage and forwards tenant plus optional refresh ID', async () => {
    const service = { getPlanUsage: jest.fn().mockResolvedValue([{ tenant_provider_id: 'tp-1' }]) };
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
});
