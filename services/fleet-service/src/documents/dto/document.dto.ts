import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { FleetDocumentType } from '@veo/shared-types';
import { DocumentSide, FleetOwnerType } from '../../generated/prisma';

/** Tope defensivo de imágenes por documento (DNI = 2; foto de vehículo N). Evita payloads abusivos. */
export const MAX_DOCUMENT_IMAGES = 10;

/**
 * Una imagen del documento (sub-lote 3A · múltiples imágenes). `s3Key` es la clave ya subida a S3 (vía
 * el presign driver/vehicle-scoped); `side` es la cara (FRONT|BACK|SINGLE) tipada — sin string suelto.
 */
export class DocumentImageInputDto {
  @ApiProperty({ description: 'Clave del binario en S3 (subido vía presign driver/vehicle-scoped)' })
  @IsString()
  @Length(1, 1024)
  s3Key!: string;

  @ApiProperty({ enum: DocumentSide, description: 'Cara del documento: FRONT | BACK | SINGLE' })
  @IsEnum(DocumentSide)
  side!: DocumentSide;
}

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

  /**
   * DEPRECADO (sub-lote 3A): llave singular del archivo. El camino nuevo es `images` (1..N). Se mantiene
   * por backward-compat: si llega `fileS3Key` y NO `images`, el service lo normaliza a una imagen SINGLE.
   */
  @ApiPropertyOptional({ description: 'DEPRECADO: usar `images`. Llave singular del archivo en S3' })
  @IsOptional()
  @IsString()
  fileS3Key?: string;

  /**
   * Imágenes del documento (camino NUEVO, sub-lote 3A): 1..N caras. DNI → [FRONT, BACK]; foto de
   * vehículo → N SINGLE; el resto → [SINGLE]. Opcional para no romper a quien aún manda `fileS3Key`
   * (o nada, si el archivo se sube por otra vía). El service valida la coherencia de `side` por tipo.
   */
  @ApiPropertyOptional({ type: [DocumentImageInputDto], description: 'Imágenes del documento (1..N caras)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DOCUMENT_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => DocumentImageInputDto)
  images?: DocumentImageInputDto[];
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
