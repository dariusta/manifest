import { AddManualUsageLimit1802300000000 } from './1802300000000-AddManualUsageLimit';

describe('AddManualUsageLimit1802300000000', () => {
  it('adds a nullable decimal allowance to each provider connection', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };

    await new AddManualUsageLimit1802300000000().up(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "manual_usage_limit_usd" numeric(14,2)'),
    );
  });

  it('drops the allowance column on rollback', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };

    await new AddManualUsageLimit1802300000000().down(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('DROP COLUMN IF EXISTS "manual_usage_limit_usd"'),
    );
  });
});
