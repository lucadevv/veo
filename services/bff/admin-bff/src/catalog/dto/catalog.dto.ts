/**
 * DTO del overlay del catálogo en el admin-bff (ADR 013 · defensa en profundidad). El PUT REEMPLAZA
 * wholesale: validamos la lista de overrides con class-validator — espejo del DTO de trip-service, que
 * RE-VALIDA aguas abajo. `id` debe ser un OfferingId conocido; sin ids duplicados.
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

/** Techo de cordura de la tarifa mínima por oferta: S/1000 (espejo de trip-service). */
export const MIN_FARE_MAX_CENTS = 100_000;

const OFFERING_IDS = Object.values(OfferingId);
const PRICING_MODES = Object.values(PricingMode);

/** Override de UNA oferta: habilitarla o no (B1) + pin de modo y precio (B2). */
export class OfferingOverrideDto {
  @ApiProperty({ enum: OFFERING_IDS, description: 'Id de la oferta del catálogo' })
  @IsIn(OFFERING_IDS)
  id!: OfferingId;

  @ApiProperty({ description: 'Si la oferta está habilitada (visible y cotizable)' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ enum: PRICING_MODES, description: 'B2: pin del modo (PUJA/FIXED). ∉ allowedModes → se ignora.' })
  @IsOptional()
  @IsIn(PRICING_MODES)
  mode?: PricingMode;

  @ApiPropertyOptional({ description: 'B2: override del multiplicador (> 0). Ausente → el de código.' })
  @IsOptional()
  @IsPositive()
  multiplier?: number;

  @ApiPropertyOptional({ description: 'B2: override de tarifa mínima en céntimos PEN (0..100000). Ausente → la de código.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MIN_FARE_MAX_CENTS)
  minFareCents?: number;
}

/** Body del PUT /catalog — reemplazo wholesale del overlay. */
export class ReplaceCatalogDto {
  @ApiProperty({ type: [OfferingOverrideDto], description: 'Overrides por oferta (lista completa)' })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique((o: OfferingOverrideDto) => o.id, { message: 'los ids de oferta deben ser únicos' })
  @ValidateNested({ each: true })
  @Type(() => OfferingOverrideDto)
  overrides!: OfferingOverrideDto[];

  @ApiProperty({
    description: 'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
