/** DTOs de finanzas (payouts y reembolsos). */
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  IsUUID,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Listado admin de payouts: filtro por estado + paginación cursor (el estado lo valida payment-service). */
export class PayoutsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
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
