/**
 * DTOs de pricing en el admin-bff (defensa en profundidad): tarifa base (F2.4) + piso de la PUJA
 * (ADR 010 §9.3). El PUT REEMPLAZA wholesale y validamos el shape completo con class-validator —
 * espejo del DTO de trip-service, que RE-VALIDA aguas abajo.
 */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BID_FLOOR_MAX_CENTS, OfferingId } from '@veo/shared-types';

const OFFERING_IDS = Object.values(OfferingId);

/** Techos de cordura de la tarifa base (F2.4); espejo de trip-service. */
export const BASE_FARE_MAX_CENTS = 20_000;
export const PER_KM_MAX_CENTS = 5_000;
export const PER_MIN_MAX_CENTS = 2_000;

/**
 * Body del PUT /pricing/base-fare (F2.4) — el admin reemplaza los tres componentes base de la tarifa
 * (banderazo + per-km + per-min) en céntimos PEN. Espejo del DTO de trip-service (re-valida abajo).
 */
export class ReplaceBaseFareDto {
  @ApiProperty({
    description: 'Banderazo (tarifa fija de arranque) en céntimos PEN',
    minimum: 0,
    maximum: BASE_FARE_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(BASE_FARE_MAX_CENTS)
  baseFareCents!: number;

  @ApiProperty({
    description: 'Costo por kilómetro en céntimos PEN',
    minimum: 0,
    maximum: PER_KM_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(PER_KM_MAX_CENTS)
  perKmCents!: number;

  @ApiProperty({
    description: 'Costo por minuto en céntimos PEN',
    minimum: 0,
    maximum: PER_MIN_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(PER_MIN_MAX_CENTS)
  perMinCents!: number;

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. trip-service reemplaza solo si sigue ' +
      'vigente; si otro admin la movió → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/** Un override del piso de la PUJA para una OFERTA. Espejo del DTO de trip-service (re-valida abajo). */
export class BidFloorOverrideDto {
  @ApiProperty({ enum: OFFERING_IDS, description: 'Oferta a la que aplica este piso' })
  @IsIn(OFFERING_IDS)
  offeringId!: OfferingId;

  @ApiProperty({
    description: 'Piso EFECTIVO de esta oferta en céntimos PEN',
    minimum: 1,
    maximum: BID_FLOOR_MAX_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(BID_FLOOR_MAX_CENTS)
  floorCents!: number;
}

/**
 * Body del PUT /pricing/bid-floor (ADR 010 §9.3) — piso de la PUJA por defecto + overrides por oferta.
 * Reemplazo wholesale; espejo del DTO de trip-service (re-valida aguas abajo).
 */
export class ReplaceBidFloorDto {
  @ApiProperty({
    description: 'Piso por defecto en céntimos PEN (sin override para la oferta)',
    minimum: 1,
    maximum: BID_FLOOR_MAX_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(BID_FLOOR_MAX_CENTS)
  defaultFloorCents!: number;

  @ApiProperty({
    type: [BidFloorOverrideDto],
    description: 'Pisos por oferta. Sin override → el default.',
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => BidFloorOverrideDto)
  overrides!: BidFloorOverrideDto[];

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
