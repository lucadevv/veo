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

const OFFERING_IDS = Object.values(OfferingId) as string[];
const PRICING_MODES = Object.values(PricingMode);
const SERVICE_TYPES = Object.values(ServiceType);
const VEHICLE_CLASSES = Object.values(VehicleClass);

/**
 * Valida que un id de oferta sea CONOCIDO: un `OfferingId` built-in (enum) O un id CUSTOM (`custom_*`). Extiende
 * el viejo `@IsIn(OFFERING_IDS)` para que el overlay pueda configurar también las ofertas custom (ADR 013). No
 * consulta la DB (sync): `resolveCatalog` es el cinturón-y-tirantes que IGNORA un id custom que no existe en la tabla.
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

/** Techo de cordura de la tarifa mínima por oferta: S/1000 (evita un minFare absurdo por dedazo del admin). */
export const MIN_FARE_MAX_CENTS = 100_000;

/**
 * Techo de cordura del MULTIPLICADOR de tarifa: 10× (el más alto del catálogo base es 2.5, ambulancia). Da
 * margen para surge/premium legítimo y CORTA el dedazo del admin (un `100` en vez de `1.0` multiplicaría ×100
 * el cobro FIXED directo al pasajero). Espeja MIN_FARE_MAX_CENTS; el admin-bff lo duplica (defensa en profundidad).
 */
export const MULTIPLIER_MAX = 10;

/**
 * ADR 023 §3 · techos de cordura de los OVERRIDES de params por-oferta (banderazo/por-km/por-min) en céntimos
 * PEN. ESPEJAN los techos de la tarifa base GLOBAL (pricing/dto/pricing.dto): banderazo S/200, S/50/km, S/20/min
 * — holgados sobre los valores vigentes y cortan un dedazo del admin (un `600` donde iba `60` no dispara el cobro).
 */
export const BASE_FARE_MAX_CENTS = 20_000;
export const PER_KM_MAX_CENTS = 5_000;
export const PER_MIN_MAX_CENTS = 2_000;

/** Override de UNA oferta: habilitarla o no (B1) + pin de modo y precio (B2) + params por-servicio (ADR 023 §3). */
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
      'ADR 023: palanca manual del modo de pricing de la oferta. En una vertical `modeLocked` se ignora.',
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

/**
 * Body del POST /internal/catalog/offerings — ALTA de una oferta CUSTOM (ADR 013). El `vehicleClass`/`serviceType`
 * DEBEN ser tipos EXISTENTES (el dispatch/matching trabaja por vehicleClass — no se inventa un tipo de vehículo).
 * El id se GENERA server-side (`custom_*`, no lo manda el cliente). `createdBy` lo setea el admin-bff desde la
 * identidad firmada (auditoría). trip-service RE-valida los enums en el service (defensa en profundidad).
 */
export class CreateCustomOfferingDto {
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

  @ApiPropertyOptional({
    description: 'Id del admin creador (lo setea el admin-bff desde la identidad firmada; auditoría).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  createdBy?: string;
}
