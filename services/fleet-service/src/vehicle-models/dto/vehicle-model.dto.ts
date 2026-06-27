import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleType, VehicleSegment, EnergySource } from '@veo/shared-types';
import { VehicleModelStatus } from '../../generated/prisma';

/** Tope de página del catálogo (el selector del onboarding no necesita más por tirada). */
export const VEHICLE_MODEL_MAX_LIMIT = 100;

/** Cotas de sanidad para el alta de un modelo (el operador revalida al curar/aprobar). */
const MODEL_MIN_YEAR = 1990;
const MODEL_MAX_YEAR = new Date().getUTCFullYear() + 1;
/** Asientos plausibles (moto-taxi 2-3 … van 20). */
const SEATS_MIN = 1;
const SEATS_MAX = 20;
/** Rendimiento plausible en km por unidad (gasolina moto ~40 km/L; tope amplio de sanidad). */
const EFFICIENCY_MIN = 1;
const EFFICIENCY_MAX = 1000;

/**
 * Filtros del catálogo aprobado (B5-2.a). El conductor en el onboarding filtra por tipo de vehículo
 * (un mototaxista solo ve motos) y busca por marca/modelo. `q` es contains case-insensitive sobre make+model.
 */
export class ListVehicleModelsQuery {
  @ApiPropertyOptional({ enum: VehicleType, description: 'Filtra por tipo (CAR|MOTO).' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'Búsqueda por marca o modelo (contains, case-insensitive).' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  q?: string;

  @ApiPropertyOptional({ description: 'Cursor de paginación (id uuid del último visto).' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    description: `Tamaño de página (1..${VEHICLE_MODEL_MAX_LIMIT}).`,
    type: Number,
  })
  @IsOptional()
  // El pipe del fleet-service es transform:true SIN enableImplicitConversion → un query param llega como
  // string; sin @Type(() => Number) el "50" falla @IsInt() y devuelve 400 (rompía la cola de revisión).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VEHICLE_MODEL_MAX_LIMIT)
  limit?: number;
}

/**
 * Proyección pública de un modelo del catálogo. Es lo que consume el SELECTOR del onboarding y el panel
 * admin: NO expone los campos de revisión (status/requestedBy/verifiedBy) — el catálogo aprobado ya está
 * curado. `segment`/`energySource` se exponen tipados (el dato viene validado contra los enums al escribir).
 */
export interface VehicleModelSpecView {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  vehicleType: VehicleType;
  seats: number;
  segment: VehicleSegment;
  energySource: EnergySource;
  /** Rendimiento de referencia en km por unidad de energía (km/L o km/kWh). */
  efficiency: number;
}

/**
 * B5-2.c · solicitud de un modelo NUEVO por el conductor (no estaba en el catálogo). Trae solo lo que el
 * conductor conoce: marca, modelo, rango de años, tipo y asientos. Los campos técnicos (segment/energía/
 * eficiencia) los completa el OPERADOR al aprobar — no se piden acá. Entra como PENDING_REVIEW.
 */
export class RequestVehicleModelDto {
  @ApiProperty({ example: 'Toyota' })
  @IsString()
  @Length(1, 60)
  make!: string;

  @ApiProperty({ example: 'Probox' })
  @IsString()
  @Length(1, 60)
  model!: string;

  @ApiProperty({ example: 2015, description: `Año desde (>= ${MODEL_MIN_YEAR}).` })
  @IsInt()
  @Min(MODEL_MIN_YEAR)
  @Max(MODEL_MAX_YEAR)
  yearFrom!: number;

  @ApiProperty({
    example: 2024,
    description: `Año hasta (>= yearFrom, <= ${MODEL_MAX_YEAR}); el servicio valida el rango.`,
  })
  @IsInt()
  @Min(MODEL_MIN_YEAR)
  @Max(MODEL_MAX_YEAR)
  yearTo!: number;

  @ApiProperty({ enum: VehicleType, description: 'CAR | MOTO.' })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: 5, description: `Asientos (${SEATS_MIN}..${SEATS_MAX}).` })
  @IsInt()
  @Min(SEATS_MIN)
  @Max(SEATS_MAX)
  seats!: number;
}

/**
 * B5-2.c · aprobación de una solicitud por el OPERADOR: completa la ficha técnica (segment/energía/
 * eficiencia) que el conductor no conoce, y opcionalmente corrige los asientos. Mueve PENDING→APPROVED.
 */
export class ApproveVehicleModelDto {
  @ApiProperty({ enum: VehicleSegment, description: 'ECONOMY | MID | PREMIUM.' })
  @IsEnum(VehicleSegment)
  segment!: VehicleSegment;

  @ApiProperty({
    enum: EnergySource,
    description: 'GASOLINE_90 | DIESEL | ELECTRIC.',
  })
  @IsEnum(EnergySource)
  energySource!: EnergySource;

  @ApiProperty({
    example: 17,
    description: `Rendimiento km por unidad (${EFFICIENCY_MIN}..${EFFICIENCY_MAX}).`,
  })
  @IsInt()
  @Min(EFFICIENCY_MIN)
  @Max(EFFICIENCY_MAX)
  efficiency!: number;

  @ApiPropertyOptional({
    example: 5,
    description: `Corrige los asientos del conductor si hace falta (${SEATS_MIN}..${SEATS_MAX}).`,
  })
  @IsOptional()
  @IsInt()
  @Min(SEATS_MIN)
  @Max(SEATS_MAX)
  seats?: number;
}

/** Filtro de la cola de revisión del operador (B5-2.c): por estado (default PENDING_REVIEW). */
export class ListReviewQuery {
  @ApiPropertyOptional({
    enum: VehicleModelStatus,
    description:
      'Estado a listar (default PENDING_REVIEW). El operador puede auditar APPROVED/REJECTED.',
  })
  @IsOptional()
  @IsEnum(VehicleModelStatus)
  status?: VehicleModelStatus;

  @ApiPropertyOptional({ description: 'Cursor de paginación (id uuid del último visto).' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    description: `Tamaño de página (1..${VEHICLE_MODEL_MAX_LIMIT}).`,
    type: Number,
  })
  @IsOptional()
  // El pipe del fleet-service es transform:true SIN enableImplicitConversion → un query param llega como
  // string; sin @Type(() => Number) el "50" falla @IsInt() y devuelve 400 (rompía la cola de revisión).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VEHICLE_MODEL_MAX_LIMIT)
  limit?: number;
}

/**
 * Vista ADMIN de un modelo (cola de revisión): incluye el estado de revisión y quién lo solicitó/verificó,
 * y los campos técnicos pueden venir NULL (una solicitud PENDING aún no los tiene). No es la vista pública.
 */
export interface VehicleModelReviewView {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  vehicleType: VehicleType;
  seats: number;
  segment: VehicleSegment | null;
  energySource: EnergySource | null;
  efficiency: number | null;
  status: string;
  requestedBy: string | null;
  verifiedBy: string | null;
  createdAt: string;
}
