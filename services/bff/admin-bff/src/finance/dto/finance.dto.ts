/** DTOs de finanzas (payouts y reembolsos). */
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
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

/**
 * Reemplaza la tasa de comisión ON-DEMAND (F2.7). La tasa va en BASIS POINTS Int (0..10000; 2000 = 20%) —
 * jamás float. El carpooling NO se configura acá (0 fijo legal · ADR-015 §11.2). `expectedVersion` = CAS.
 */
export class ReplaceCommissionDto {
  @IsInt()
  @Min(0)
  @Max(10_000)
  onDemandRateBps!: number;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
