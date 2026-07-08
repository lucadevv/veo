/**
 * DTO del piso de la PUJA (ADR 010 §9.3). El PUT REEMPLAZA wholesale: validamos el shape completo
 * (defaultFloorCents + overrides) con class-validator, espejo del payload pricing.bid_floor_updated.
 * El valor enumerado (oferta) se valida contra el enum TIPADO de @veo/shared-types — nunca un string suelto.
 */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BID_FLOOR_MAX_CENTS, OfferingId } from '@veo/shared-types';

/** Valores permitidos (enum tipado, no literales sueltos). */
const OFFERING_IDS = Object.values(OfferingId);

/** Un override del piso para una OFERTA concreta. */
export class BidFloorOverrideDto {
  @ApiProperty({ enum: OFFERING_IDS, description: 'Oferta a la que aplica este piso' })
  @IsIn(OFFERING_IDS)
  offeringId!: OfferingId;

  @ApiProperty({
    description: 'Piso EFECTIVO de esta oferta en céntimos PEN (1..100000)',
    minimum: 1,
    maximum: BID_FLOOR_MAX_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(BID_FLOOR_MAX_CENTS)
  floorCents!: number;
}

/** Body del PUT /internal/pricing/bid-floor — reemplazo wholesale del piso (default + overrides). */
export class ReplaceBidFloorDto {
  @ApiProperty({
    description: 'Piso por defecto en céntimos PEN cuando no hay override para la oferta (1..100000)',
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
      'Optimistic locking (CAS): la `version` que el panel cargó. Se reemplaza solo si sigue vigente; ' +
      'si otro admin la movió → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
