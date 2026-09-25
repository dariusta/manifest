import { AddOAuthPendingFlowReconnectLabel1802600000000 } from './1802600000000-AddOAuthPendingFlowReconnectLabel';

describe('AddOAuthPendingFlowReconnectLabel1802600000000', () => {
  it('adds a nullable reconnect label to pending OAuth flows', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };

    await new AddOAuthPendingFlowReconnectLabel1802600000000().up(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "reconnect_label" varchar'),
    );
  });

  it('drops the reconnect label on rollback', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };

    await new AddOAuthPendingFlowReconnectLabel1802600000000().down(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('DROP COLUMN IF EXISTS "reconnect_label"'),
    );
  });
});
