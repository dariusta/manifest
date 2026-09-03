import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

export class ManualUsageLimitDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999999999999)
  limitUsd!: number;
}
