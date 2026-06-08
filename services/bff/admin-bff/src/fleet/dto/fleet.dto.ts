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
import { FleetDocumentType } from '@veo/shared-types';

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

export class DocumentsQueryDto {
  @IsString()
  ownerId!: string;
}

export class InspectionsQueryDto {
  @IsUUID()
  vehicleId!: string;
}

export class ExpirationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
