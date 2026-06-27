/**
 * DTOs del endpoint interno de comisión por modo (F2.7). AMBAS tasas van en BASIS POINTS Int (0..10000) — jamás
 * float. Full-replace. `expectedVersion` = optimistic locking (CAS). Espeja ReplaceBaseFareDto de trip-service.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { BPS_DENOMINATOR } from '../../payments/payment.policy';

export class ReplaceCommissionDto {
  @ApiProperty({
    description:
      'Tasa de comisión ON-DEMAND en basis points (0..10000; 2000 = 20%). Int, jamás float. Es la comisión ' +
      'que se DESCUENTA al conductor.',
    minimum: 0,
    maximum: BPS_DENOMINATOR,
  })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  onDemandRateBps!: number;

  @ApiProperty({
    description:
      'Service fee CARPOOLING en basis points (0..10000). Int, jamás float. Es el fee que se SUMA al pasajero ' +
      '(cost-sharing): el conductor cobra el 100% de su contribución.',
    minimum: 0,
    maximum: BPS_DENOMINATOR,
  })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  carpoolingFeeBps!: number;

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el cliente cargó. El server REEMPLAZA solo si la versión ' +
      'vigente sigue siendo esta; si otro admin la movió → 409 ConflictError. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
