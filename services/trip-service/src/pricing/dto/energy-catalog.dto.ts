/**
 * DTO del catálogo de energía (B5). El PUT REEMPLAZA wholesale la lista de precios por fuente. El admin
 * ingresa el PRECIO por unidad (céntimos PEN); la `unit` NO se ingresa — se deriva de la fuente
 * (ENERGY_SOURCE_UNIT) en el controller, así no se puede declarar gasolina en kWh. `sourceId` debe ser
 * una EnergySource conocida; sin fuentes duplicadas.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EnergySource } from '@veo/shared-types';

const ENERGY_SOURCES = Object.values(EnergySource);

/** Techo de cordura del precio de energía: S/100 por unidad (litro o kWh). Evita un dedazo catastrófico. */
export const ENERGY_PRICE_MAX_CENTS = 10_000;

/** Precio de UNA fuente de energía. */
export class EnergySourcePriceDto {
  @ApiProperty({ enum: ENERGY_SOURCES, description: 'Fuente de energía (GASOLINE_95, DIESEL, ELECTRIC, …)' })
  @IsIn(ENERGY_SOURCES)
  sourceId!: EnergySource;

  @ApiProperty({
    description: 'Precio por unidad (céntimos PEN/litro o céntimos PEN/kWh según la fuente). 0..10000.',
    minimum: 0,
    maximum: ENERGY_PRICE_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(ENERGY_PRICE_MAX_CENTS)
  pricePerUnitCents!: number;
}

/** Body del PUT /internal/pricing/energy-catalog — reemplazo wholesale de los precios de energía. */
export class ReplaceEnergyCatalogDto {
  @ApiProperty({ type: [EnergySourcePriceDto], description: 'Precios por fuente (lista completa)' })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique((s: EnergySourcePriceDto) => s.sourceId, { message: 'las fuentes de energía deben ser únicas' })
  @ValidateNested({ each: true })
  @Type(() => EnergySourcePriceDto)
  sources!: EnergySourcePriceDto[];

  @ApiProperty({
    description: 'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
