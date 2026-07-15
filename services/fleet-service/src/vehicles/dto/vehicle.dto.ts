import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  PLATE_PATTERN,
  PLATE_INVALID_MESSAGE,
  VehicleType,
  type FleetDocumentType,
} from '@veo/shared-types';
import type { VehicleReviewStatus } from '../vehicle-rules';

const CURRENT_YEAR = new Date().getUTCFullYear();

/** Año mínimo aceptado por la validación de forma (sanity check); BR-D04 (>=2017) se valida en el servicio. */
const MIN_REASONABLE_YEAR = 2005;

/** Formato de la categoría MTC cruda: clase `[LMNO]`, dígito de subclase y sufijos opcionales (`M1`, `L3`, `M1SC`). */
const MTC_CATEGORY_PATTERN = /^[LMNO]\d[A-Z]*$/i;

export class CreateVehicleDto {
  @ApiProperty({ example: 'ABC-123', description: 'Placa peruana (ABC-123 / A1B-234)' })
  @IsString()
  plate!: string;

  @ApiPropertyOptional({
    description:
      'Id del modelo del catálogo (VehicleModelSpec APPROVED) que el operador eligió (F4). Si viene, ' +
      'make/model/vehicleType se snapshotean del spec (server-authoritative) e ignoran el texto libre.',
  })
  @IsOptional()
  @IsUUID()
  modelSpecId?: string;

  @ApiPropertyOptional({
    example: 'Toyota',
    description:
      'Marca a texto libre. Requerida solo si NO se eligió un modelo del catálogo (modelSpecId).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional({
    example: 'Yaris',
    description:
      'Modelo a texto libre. Requerido solo si NO se eligió un modelo del catálogo (modelSpecId).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiProperty({ example: 2020, description: 'BR-D04: año >= VEHICLE_MIN_YEAR (2017)' })
  @IsInt()
  @Min(1980)
  @Max(CURRENT_YEAR + 1)
  year!: number;

  @ApiProperty({ example: 'Plata' })
  @IsString()
  @Length(1, 30)
  color!: string;

  @ApiPropertyOptional({
    enum: VehicleType,
    default: VehicleType.CAR,
    description: 'Tipo de vehículo (Ola 2B · moto-taxi). MOTO habilita el matching de viajes MOTO.',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'Id de la flota a la que pertenece (si aplica)' })
  @IsOptional()
  @IsString()
  fleetId?: string;

  @ApiPropertyOptional({
    description: 'Vencimiento del seguro (SOAT/póliza)',
    example: '2026-12-31T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  insuranceExpiresAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * Alta self-service del conductor (onboarding). El vehículo queda asociado al conductor
 * (driverId del header de identidad interna) y pendiente de verificación (active=false).
 */
export class RegisterDriverVehicleDto {
  @ApiProperty({
    enum: VehicleType,
    description:
      'Tipo de vehículo (HINT/fallback). CAR = automóvil; MOTO = moto-taxi. LOTE 1: si viene `mtcCategory`, ' +
      'el servidor DERIVA el tipo de la categoría (la tarjeta es la fuente de verdad) y este valor solo se usa ' +
      'cuando la categoría no es derivable (manual/no soportada).',
  })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiPropertyOptional({
    example: 'L3',
    description:
      'LOTE 1 · categoría MTC CRUDA leída de la tarjeta de propiedad / TIVe (`M1`, `L3`, `N1`, `M1SC`…). FUENTE ' +
      'DE VERDAD del tipo: el servidor deriva `vehicleType` de acá (M1→CAR, L*→MOTO; resto→hint del body). Se ' +
      'persiste cruda para auditoría/re-derivación. Ausente en la carga manual del tipo o el alta legacy.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 16)
  @Matches(MTC_CATEGORY_PATTERN, {
    message: 'Categoría MTC inválida (formato [LMNO] + dígito + sufijo, ej. M1/L3/M1SC)',
  })
  mtcCategory?: string;

  @ApiProperty({
    example: 'ABC-123',
    description: 'Placa peruana (auto ABC-123 o moto 1234-AB, guion opcional)',
  })
  @IsString()
  @Matches(PLATE_PATTERN, { message: PLATE_INVALID_MESSAGE })
  plate!: string;

  @ApiPropertyOptional({
    description:
      'Id del modelo del catálogo (VehicleModelSpec APPROVED) que el conductor eligió. Si viene, ' +
      'make/model/vehicleType se snapshotean del spec (server-authoritative) e ignoran los de texto libre.',
  })
  @IsOptional()
  @IsUUID()
  modelSpecId?: string;

  @ApiPropertyOptional({
    example: 'Honda',
    description:
      'Marca a texto libre. Requerida solo si NO se eligió un modelo del catálogo (modelSpecId).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional({
    example: 'CG 150',
    description:
      'Modelo a texto libre. Requerido solo si NO se eligió un modelo del catálogo (modelSpecId).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiProperty({
    example: 2021,
    description: `Año del vehículo (>= ${MIN_REASONABLE_YEAR}). BR-D04 (>=2017) se aplica en el servicio.`,
  })
  @IsInt()
  @Min(MIN_REASONABLE_YEAR)
  @Max(CURRENT_YEAR + 1)
  year!: number;

  @ApiPropertyOptional({ example: 'Rojo' })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  color?: string;
}

/** Respuesta del alta/consulta self-service: subconjunto del vehículo + estado de revisión derivado. */
export interface DriverVehicleResponse {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: VehicleType;
  docStatus: string;
  status: VehicleReviewStatus;
  /** true si este es el vehículo ACTIVO (el que el conductor opera; server-authoritative). */
  isActive: boolean;
  /**
   * B5-3 · atributos de eligibilidad del modelo elegido (asientos/segmento). SOLO se llenan en la consulta
   * del vehículo ACTIVO (getActiveVehicle), para que el driver-bff los selle en el ping y dispatch filtre
   * por oferta. Ausentes si el vehículo es legacy/texto-libre (sin modelSpecId) ⇒ degradación honesta.
   */
  seats?: number;
  segment?: string;
  /**
   * B5-3.2 · certificaciones de operador VIGENTES del conductor (no del vehículo). SOLO se llenan en la
   * consulta del vehículo ACTIVO, para que el driver-bff las selle en el ping y dispatch gatee las verticales
   * (ambulancia exige AMBULANCE_OPERATOR) FAIL-CLOSED. Vacío si el conductor no tiene certs vigentes.
   */
  certifications?: FleetDocumentType[];
}

/** Body para seleccionar el vehículo ACTIVO del conductor (PATCH /drivers/vehicles/active). */
export class SelectVehicleDto {
  @ApiProperty({ description: 'Id del vehículo del conductor a marcar como activo' })
  @IsUUID()
  vehicleId!: string;
}
