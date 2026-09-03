import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ManualUsageLimitDto } from './plan-usage.dto';

describe('ManualUsageLimitDto', () => {
  it('accepts a positive numeric allowance', async () => {
    const dto = plainToInstance(ManualUsageLimitDto, { limitUsd: '75.50' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.limitUsd).toBe(75.5);
  });

  it.each([0, -1, 'nope', 1_000_000_000_000])('rejects unsafe allowance %p', async (value) => {
    const dto = plainToInstance(ManualUsageLimitDto, { limitUsd: value });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
