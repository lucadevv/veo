/** DTOs de flota/compliance. */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FleetDocumentType, FleetDocumentStatus, VehicleSegment, EnergySource } from '@veo/shared-types';

/** Estados de revisión del catálogo de modelos (espeja VehicleModelStatus de fleet-service). */
const VEHICLE_MODEL_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;

export class CreateVehicleDto {
  @IsString()
  plate!: string;

  @IsString()
  make!: string;

  @IsString()
  model!: string;

  @IsInt()
  @Min(1950)
  @Max(2100)
  year!: number;

  @IsString()
  color!: string;

  @IsOptional()
  @IsString()
  fleetId?: string;

  @IsOptional()
  @IsISO8601()
  insuranceExpiresAt?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateDocumentDto {
  @IsIn(['DRIVER', 'VEHICLE'])
  ownerType!: 'DRIVER' | 'VEHICLE';

  @IsString()
  ownerId!: string;

  @IsIn(Object.values(FleetDocumentType))
  type!: FleetDocumentType;

  @IsString()
  documentNumber!: string;

  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  fileS3Key?: string;
}

export class ReviewDocumentDto {
  @IsIn(['VALID', 'REJECTED'])
  decision!: 'VALID' | 'REJECTED';
}

export class CreateInspectionDto {
  @IsUUID()
  vehicleId!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsISO8601()
  inspectedAt?: string;

  @IsOptional()
  @IsUUID()
  inspectorId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** Paginación cursor común a las listas de flota (cursor = id uuidv7 de la última fila previa). */
class PaginatedQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListVehiclesQueryDto extends PaginatedQueryDto {
  /** Estado documental del vehículo (VehicleDocStatus). Opcional. */
  @IsOptional()
  @IsString()
  status?: string;
}

export class ListDocumentsQueryDto extends PaginatedQueryDto {
  /** Estado del documento. Validado contra el enum real: un valor inválido falla 400 (no filtra a vacío). */
  @IsOptional()
  @IsIn(Object.values(FleetDocumentStatus))
  status?: FleetDocumentStatus;

  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class ListInspectionsQueryDto extends PaginatedQueryDto {
  @IsOptional()
  @IsUUID()
  vehicleId?: string;
}

export class ExpirationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

/** Cola de revisión del catálogo de modelos (B5-2.c). Filtro por estado (default PENDING_REVIEW en fleet). */
export class ListModelReviewQueryDto extends PaginatedQueryDto {
  @IsOptional()
  @IsIn(VEHICLE_MODEL_STATUSES)
  status?: (typeof VEHICLE_MODEL_STATUSES)[number];
}

/** Aprobación de una solicitud de modelo: el operador completa la ficha técnica (B5-2.c). */
export class ApproveVehicleModelDto {
  @IsIn(Object.values(VehicleSegment))
  segment!: VehicleSegment;

  @IsIn(Object.values(EnergySource))
  energySource!: EnergySource;

  @IsInt()
  @Min(1)
  @Max(1000)
  efficiency!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  seats?: number;
}
