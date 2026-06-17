import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString, Length } from 'class-validator';
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

  @ApiProperty({ example: 'Q-12345678' })
  @IsString()
  @Length(1, 60)
  documentNumber!: string;

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
}
