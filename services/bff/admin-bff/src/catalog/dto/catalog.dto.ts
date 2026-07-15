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
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OfferingId,
  PricingMode,
  ServiceType,
  VehicleClass,
  isCustomOfferingId,
} from '@veo/shared-types';

/** Techo de cordura de la tarifa mínima por oferta: S/1000 (espejo de trip-service). */
export const MIN_FARE_MAX_CENTS = 100_000;

/** Techo de cordura del multiplicador de tarifa: 10× (espejo de trip-service, que RE-valida). Corta el dedazo ×100. */
export const MULTIPLIER_MAX = 10;

/**
 * ADR 023 §3 · techos de cordura de los OVERRIDES de params por-oferta (banderazo/por-km/por-min) en céntimos
 * PEN. Espejo de los techos de la tarifa base GLOBAL de trip-service; el productor RE-valida (defensa en profundidad).
 */
export const BASE_FARE_MAX_CENTS = 20_000;
export const PER_KM_MAX_CENTS = 5_000;
export const PER_MIN_MAX_CENTS = 2_000;

const OFFERING_IDS = Object.values(OfferingId) as string[];
const PRICING_MODES = Object.values(PricingMode);
const SERVICE_TYPES = Object.values(ServiceType);
const VEHICLE_CLASSES = Object.values(VehicleClass);

/**
 * Valida un id de oferta CONOCIDO: `OfferingId` built-in O id CUSTOM (`custom_*`). Espejo del validador de
 * trip-service (defensa en profundidad): el overlay configura también las custom (ADR 013). trip-service RE-valida.
 */
function IsOfferingIdOrCustom(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isOfferingIdOrCustom',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' && (OFFERING_IDS.includes(value) || isCustomOfferingId(value))
          );
        },
        defaultMessage(): string {
          return 'id debe ser una oferta conocida (OfferingId) o una oferta custom (custom_*)';
        },
      },
    });
  };
}

/** Override de UNA oferta: habilitarla o no (B1) + pin de modo y precio (B2). */
export class OfferingOverrideDto {
  @ApiProperty({ description: 'Id de la oferta del catálogo (OfferingId built-in o custom_*)' })
  @IsOfferingIdOrCustom()
  id!: string;

  @ApiProperty({ description: 'Si la oferta está habilitada (visible y cotizable)' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    enum: PRICING_MODES,
    description:
      'ADR 023: palanca manual del modo de pricing de la oferta (PUJA/FIXED). En una vertical `modeLocked` se ignora.',
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
      'B2: override de tarifa mínima en céntimos PEN (0..100000). Ausente → la de código.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MIN_FARE_MAX_CENTS)
  minFareCents?: number;

  @ApiPropertyOptional({
    description:
      'ADR 023 §3: override del banderazo por-oferta en céntimos PEN (0..20000). Ausente → el default global.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(BASE_FARE_MAX_CENTS)
  baseFareCents?: number;

  @ApiPropertyOptional({
    description:
      'ADR 023 §3: override del costo por-km por-oferta en céntimos PEN (0..5000). 0 = no cobra distancia (Mecánico). Ausente → el default global.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PER_KM_MAX_CENTS)
  perKmCents?: number;

  @ApiPropertyOptional({
    description:
      'ADR 023 §3: override del costo por-min por-oferta en céntimos PEN (0..2000). 0 = no cobra tiempo (Grúa/Mecánico). Ausente → el default global.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PER_MIN_MAX_CENTS)
  perMinCents?: number;
}

/** Body del PUT /catalog — reemplazo wholesale del overlay. */
export class ReplaceCatalogDto {
  @ApiProperty({
    type: [OfferingOverrideDto],
    description: 'Overrides por oferta (lista completa)',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique((o: OfferingOverrideDto) => o.id, { message: 'los ids de oferta deben ser únicos' })
  @ValidateNested({ each: true })
  @Type(() => OfferingOverrideDto)
  overrides!: OfferingOverrideDto[];

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/**
 * Body del POST /catalog/offerings — ALTA de una oferta CUSTOM (ADR 013). El cliente NO manda el id (lo genera
 * trip-service) ni el `createdBy` (lo pone el bff desde la identidad firmada). `vehicleClass`/`serviceType` DEBEN
 * ser tipos EXISTENTES. Espejo del DTO de trip-service, que RE-valida aguas abajo (defensa en profundidad).
 */
export class CreateOfferingDto {
  @ApiProperty({ description: 'Nombre display de la oferta (ej. "VEO Playa").' })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  name!: string;

  @ApiProperty({ enum: VEHICLE_CLASSES, description: 'Clase de vehículo EXISTENTE (pool de matching).' })
  @IsIn(VEHICLE_CLASSES)
  vehicleClass!: VehicleClass;

  @ApiProperty({ enum: SERVICE_TYPES, description: 'Vertical del servicio EXISTENTE.' })
  @IsIn(SERVICE_TYPES)
  serviceType!: ServiceType;

  @ApiProperty({ enum: PRICING_MODES, description: 'Modo de pricing inicial (PUJA/FIXED).' })
  @IsIn(PRICING_MODES)
  mode!: PricingMode;

  @ApiProperty({ description: 'Multiplicador sobre la fórmula base (0 < x ≤ 10).' })
  @IsPositive()
  @Max(MULTIPLIER_MAX)
  multiplier!: number;

  @ApiProperty({ description: 'Tarifa mínima en céntimos PEN (0..100000).' })
  @IsInt()
  @Min(0)
  @Max(MIN_FARE_MAX_CENTS)
  minFareCents!: number;

  @ApiPropertyOptional({ description: 'Visible/cotizable por default (default true).' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
