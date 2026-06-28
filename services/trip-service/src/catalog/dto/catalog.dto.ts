/**
 * DTO del overlay del catálogo (ADR 013 §1.2). El PUT REEMPLAZA wholesale: validamos la lista entera de
 * overrides con class-validator. `id` debe ser un OfferingId conocido (un id fantasma se rechaza acá; el
 * resolver además lo ignora — cinturón y tirantes).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OfferingId, PricingMode } from '@veo/shared-types';

const OFFERING_IDS = Object.values(OfferingId);
const PRICING_MODES = Object.values(PricingMode);

/** Techo de cordura de la tarifa mínima por oferta: S/1000 (evita un minFare absurdo por dedazo del admin). */
export const MIN_FARE_MAX_CENTS = 100_000;

/**
 * Techo de cordura del MULTIPLICADOR de tarifa: 10× (el más alto del catálogo base es 2.5, ambulancia). Da
 * margen para surge/premium legítimo y CORTA el dedazo del admin (un `100` en vez de `1.0` multiplicaría ×100
 * el cobro FIXED directo al pasajero). Espeja MIN_FARE_MAX_CENTS; el admin-bff lo duplica (defensa en profundidad).
 */
export const MULTIPLIER_MAX = 10;

/** Override de UNA oferta: habilitarla o no (B1) + pin de modo y precio (B2). */
export class OfferingOverrideDto {
  @ApiProperty({ enum: OFFERING_IDS, description: 'Id de la oferta del catálogo' })
  @IsIn(OFFERING_IDS)
  id!: OfferingId;

  @ApiProperty({ description: 'Si la oferta está habilitada (visible y cotizable)' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    enum: PRICING_MODES,
    description:
      'B2: pin del modo de pricing. Si ∉ allowedModes de la oferta, se ignora (la oferta veta).',
  })
  @IsOptional()
  @IsIn(PRICING_MODES)
  mode?: PricingMode;

  @ApiPropertyOptional({
    description: 'B2: override del multiplicador (0 < x ≤ 10). Ausente → el de código.',
  })
  @IsOptional()
  @IsPositive()
  @Max(MULTIPLIER_MAX)
  multiplier?: number;

  @ApiPropertyOptional({
    description:
      'B2: override de la tarifa mínima en céntimos PEN (0..100000). Ausente → la de código.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MIN_FARE_MAX_CENTS)
  minFareCents?: number;
}

/** Body del PUT /internal/catalog — reemplazo wholesale del overlay. */
export class ReplaceCatalogDto {
  @ApiProperty({
    type: [OfferingOverrideDto],
    description: 'Overrides por oferta (lista completa)',
  })
  @IsArray()
  @ArrayMaxSize(100)
  // Una oferta NO puede aparecer dos veces (el overlay se keyea por id; un duplicado sería ambiguo).
  @ArrayUnique((o: OfferingOverrideDto) => o.id, { message: 'los ids de oferta deben ser únicos' })
  @ValidateNested({ each: true })
  @Type(() => OfferingOverrideDto)
  overrides!: OfferingOverrideDto[];

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
