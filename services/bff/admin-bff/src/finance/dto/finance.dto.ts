/** DTOs de finanzas (payouts y reembolsos). */
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
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
 * Reemplaza AMBAS tasas de comisión (F2.7 · full-replace): la comisión ON-DEMAND (descontada al conductor) y el
 * service fee CARPOOLING (sumado al pasajero). En BASIS POINTS Int (0..10000; 2000 = 20%) — jamás float.
 * `expectedVersion` = CAS.
 */
export class ReplaceCommissionDto {
  @IsInt()
  @Min(0)
  @Max(10_000)
  onDemandRateBps!: number;

  @IsInt()
  @Min(0)
  @Max(10_000)
  carpoolingFeeBps!: number;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/**
 * Reemplaza el costo de OPERACIÓN por km de UN país (F2.5 · escudo legal anti-lucro del carpooling). El costo
 * va en CÉNTIMOS PEN Int (combustible + desgaste; PE real = 150 = S/1.50/km) — jamás float. `expectedVersion`
 * = CAS per-país. booking-service re-valida RBAC + step-up y aplica el CAS (defensa en profundidad).
 */
export class ReplaceCostPerKmDto {
  @IsIn(['PE', 'EC'])
  pais!: 'PE' | 'EC';

  @IsInt()
  @Min(1)
  @Max(10_000)
  costPerKmCents!: number;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
