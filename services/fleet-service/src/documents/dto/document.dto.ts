import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { FleetDocumentType } from '@veo/shared-types';
import { FleetOwnerType } from '../../generated/prisma';

export class CreateDocumentDto {
  @ApiProperty({ enum: FleetOwnerType, description: 'Dueño del documento: conductor o vehículo' })
  @IsEnum(FleetOwnerType)
  ownerType!: FleetOwnerType;

  @ApiProperty({ description: 'driverId (identity) si DRIVER, o vehicleId (fleet) si VEHICLE' })
  @IsString()
  ownerId!: string;

  @ApiProperty({ enum: FleetDocumentType })
  @IsEnum(FleetDocumentType)
  type!: FleetDocumentType;

  // Requerido POR TIPO: la foto del vehículo (VEHICLE_PHOTO) no tiene número; el resto (licencia/SOAT/…) sí.
  @ApiPropertyOptional({ example: 'Q-12345678', description: 'Número (requerido salvo VEHICLE_PHOTO)' })
  @ValidateIf((o: CreateDocumentDto) => o.type !== FleetDocumentType.VEHICLE_PHOTO)
  @IsString()
  @Length(1, 60)
  documentNumber?: string;

  @ApiPropertyOptional({ example: '2024-01-15T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({ example: '2027-01-15T00:00:00.000Z', description: 'Vencimiento (BR-I04)' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Llave del archivo en S3 (gestionado por media-service)' })
  @IsOptional()
  @IsString()
  fileS3Key?: string;
}

export enum ReviewDecision {
  VALID = 'VALID',
  REJECTED = 'REJECTED',
}

export class ReviewDocumentDto {
  @ApiProperty({
    enum: ReviewDecision,
    description: 'Resultado de la revisión manual del operador',
  })
  @IsEnum(ReviewDecision)
  decision!: ReviewDecision;

  // M5: motivo OBLIGATORIO cuando se RECHAZA — el conductor lo necesita para saber qué corregir; un rechazo
  // sin motivo derrota el propósito. @ValidateIf lo exige SOLO en REJECTED (en VALID se omite y se ignora).
  @ApiPropertyOptional({ description: 'Motivo del rechazo (OBLIGATORIO si REJECTED); visible para el conductor' })
  @ValidateIf((o: ReviewDocumentDto) => o.decision === ReviewDecision.REJECTED)
  @IsString()
  @Length(1, 500)
  reason?: string;
}
