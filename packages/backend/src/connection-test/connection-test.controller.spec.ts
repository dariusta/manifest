import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ConnectionTestController } from './connection-test.controller';

describe('ConnectionTestController', () => {
  it('exposes POST /api/v1/providers/connection-test/:connectionId and forwards the tenant', async () => {
    const service = { test: jest.fn().mockResolvedValue({ connection_id: 'tp-1', status: 'ok' }) };
    const controller = new ConnectionTestController(service as never);

    await expect(
      controller.test({ tenantId: 'tenant-1', userId: 'user-1' }, 'tp-1'),
    ).resolves.toEqual({ connection_id: 'tp-1', status: 'ok' });
    expect(service.test).toHaveBeenCalledWith('tenant-1', 'tp-1');
    expect(Reflect.getMetadata(PATH_METADATA, ConnectionTestController)).toBe(
      'api/v1/providers/connection-test',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, ConnectionTestController.prototype.test)).toBe(
      RequestMethod.POST,
    );
  });
});
