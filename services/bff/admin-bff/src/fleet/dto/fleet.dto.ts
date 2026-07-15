/** DTOs de flota/compliance. */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DocumentSide,
  FleetDocumentType,
  FleetDocumentStatus,
  VehicleSegment,
  VehicleType,
  EnergySource,
} from '@veo/shared-types';

/** Tope de imágenes por documento (sub-lote 3A). Espeja MAX_DOCUMENT_IMAGES de fleet-service. */
const MAX_DOCUMENT_IMAGES = 10;

/** Una imagen del documento en el alta del operador (sub-lote 3A): clave S3 ya subida + cara tipada. */
export class CreateDocumentImageDto {
  @IsString()
  s3Key!: string;

  @IsEnum(DocumentSide)
  side!: DocumentSide;
}

/** Estados de revisión del catálogo de modelos (espeja VehicleModelStatus de fleet-service). */
const VEHICLE_MODEL_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;

export class CreateVehicleDto {
  @IsString()
  plate!: string;

  // F4 (C2): el operador elige un modelo del catálogo (modelSpecId APPROVED); fleet snapshotea
  // make/model/vehicleType del spec. make/model libres siguen aceptados (seeds/scripts) — fleet exige uno
  // de los dos caminos. El admin-bff solo proxya; la validación cruzada vive en fleet-service.
  @IsOptional()
  @IsUUID()
  modelSpecId?: string;

  @IsOptional()
  @IsString()
  make?: string;

  @IsOptional()
  @IsString()
  model?: string;

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

  /** DEPRECADO (sub-lote 3A): clave singular. Usar `images`. */
  @IsOptional()
  @IsString()
  fileS3Key?: string;

  /** Imágenes del documento (sub-lote 3A · 1..N caras). DNI → [FRONT, BACK]; foto de vehículo → N SINGLE. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DOCUMENT_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => CreateDocumentImageDto)
  images?: CreateDocumentImageDto[];
}

export class ReviewDocumentDto {
  @IsIn(['VALID', 'REJECTED'])
  decision!: 'VALID' | 'REJECTED';

  // M5: motivo del rechazo (solo REJECTED) — el conductor lo VE para saber qué corregir. Opcional.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateInspectionDto {
  @IsUUID()
  vehicleId!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsISO8601()
  inspectedAt?: string;

  // SIN `inspectorId`: la identidad del inspector la fija fleet-service desde el JWT del operador (server-
  // truth). El admin-bff reenviaba el body crudo; aceptar `inspectorId` aquí permitía forjarlo end-to-end.

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  center?: string;
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

/**
 * Cola de vencimientos paginada (cursor + limit, igual que el resto de listas de flota). El cursor acá
 * NO es un id uuidv7 sino el cursor COMPUESTO (expiresAt|id) que sirve fleet-service: el admin-bff lo
 * trata como string opaco (solo lo proxya), por eso hereda el `@IsString()` de PaginatedQueryDto sin
 * validar su forma interna. `days` filtra la ventana temporal.
 */
export class ExpirationsQueryDto extends PaginatedQueryDto {
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

/** Catálogo APROBADO de modelos para el selector del alta admin (F4 · C2). Filtros: tipo + búsqueda libre. */
export class ListVehicleModelsQueryDto extends PaginatedQueryDto {
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @IsOptional()
  @IsString()
  q?: string;
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
