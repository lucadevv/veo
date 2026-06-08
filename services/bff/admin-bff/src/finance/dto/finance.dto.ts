/** DTOs de finanzas (payouts y reembolsos). */
import { IsInt, IsISO8601, IsOptional, IsString, Min, IsUUID, MinLength } from 'class-validator';

export class PayoutsQueryDto {
  @IsUUID()
  driverId!: string;
}

export class RunPayoutsDto {
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @IsOptional()
  @IsISO8601()
  periodEnd?: string;
}

export class RefundDto {
  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @MinLength(3)
  reason!: string;
}
