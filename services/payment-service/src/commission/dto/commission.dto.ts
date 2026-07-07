/**
 * DTOs del endpoint interno de comisión por modo (F2.7 · CAS desacoplada #3). Las tasas van en BASIS POINTS Int
 * (0..10000) — jamás float. La comisión ON-DEMAND y el service fee CARPOOLING se editan por SEPARADO, cada uno con
 * SU `expectedVersion` (optimistic locking · CAS independiente): editar uno ya NO 409ea el otro. Espeja
 * ReplaceBaseFareDto de trip-service.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { BPS_DENOMINATOR } from '../../payments/payment.policy';

export class ReplaceOnDemandRateDto {
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
      'Optimistic locking (CAS): la `version` de on-demand que el cliente cargó. El server edita SOLO si la ' +
      'versión vigente sigue siendo esta; si otro admin la movió → 409 ConflictError. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class ReplaceCarpoolingFeeDto {
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
      'Optimistic locking (CAS): la `carpoolingFeeVersion` que el cliente cargó (INDEPENDIENTE de la de on-demand). ' +
      'El server edita SOLO si la versión vigente sigue siendo esta; si otro admin la movió → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/**
 * P-B (ADR-022) · DTO del PUT que EDITA el fee del PSP (ProntoPaga) por MÉTODO digital, en basis points Int
 * (0..10000). El dueño carga la tarifa REAL del convenio acá (arranca en 0 = degradación honesta). CAS por `version`.
 * CASH no tiene fee (no pasa por el PSP) → no hay campo.
 */
export class ReplacePspFeeDto {
  @ApiProperty({ description: 'Fee PSP de YAPE en bps (0..10000). Int.', minimum: 0, maximum: BPS_DENOMINATOR })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  yapeFeeBps!: number;

  @ApiProperty({ description: 'Fee PSP de PLIN en bps (0..10000). Int.', minimum: 0, maximum: BPS_DENOMINATOR })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  plinFeeBps!: number;

  @ApiProperty({ description: 'Fee PSP de TARJETA en bps (0..10000). Int.', minimum: 0, maximum: BPS_DENOMINATOR })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  cardFeeBps!: number;

  @ApiProperty({
    description: 'Fee PSP de PAGOEFECTIVO en bps (0..10000). Int.',
    minimum: 0,
    maximum: BPS_DENOMINATOR,
  })
  @IsInt()
  @Min(0)
  @Max(BPS_DENOMINATOR)
  pagoefectivoFeeBps!: number;

  @ApiProperty({ description: 'Optimistic locking (CAS): la `version` vigente. 409 si otro admin la movió.', minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
