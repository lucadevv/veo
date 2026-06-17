import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  ArrayMaxSize,
  ArrayNotEmpty,
} from 'class-validator';
import { PanicStatus } from '@veo/shared-types';

export class GeoDto {
  @ApiProperty({ example: -12.0464, description: 'Latitud WGS84' })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428, description: 'Longitud WGS84' })
  @IsLongitude()
  lon!: number;
}

export class TriggerPanicDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje en curso asociado a la alerta' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Clave de idempotencia (UUIDv7) generada por el cliente. El doble submit es no-op.',
  })
  @IsUUID()
  dedupKey!: string;

  @ApiProperty({ type: GeoDto })
  @ValidateNested()
  @Type(() => GeoDto)
  geo!: GeoDto;

  @ApiProperty({
    description: 'Firma HMAC-SHA256 (hex) del mensaje canónico de pánico (BR-S04). Ver README.',
  })
  @IsString()
  signature!: string;
}

export class AppendEvidenceDto {
  @ApiProperty({
    type: [String],
    description: 'Keys S3 (Object Lock) de los objetos de evidencia subidos por media-service.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  keys!: string[];

  @ApiPropertyOptional({
    default: true,
    description: 'Si true, aplica retención WORM (Object Lock) a los objetos indicados.',
  })
  @IsOptional()
  @IsBoolean()
  finalize?: boolean;
}

export class ResolvePanicDto {
  @ApiProperty({
    enum: [PanicStatus.RESOLVED, PanicStatus.FALSE_ALARM],
    description: 'Resultado del cierre de la alerta por el operador.',
  })
  @IsEnum(PanicStatus)
  resolution!: typeof PanicStatus.RESOLVED | typeof PanicStatus.FALSE_ALARM;
}

export class ListPanicQueryDto {
  @ApiPropertyOptional({ enum: PanicStatus })
  @IsOptional()
  @IsEnum(PanicStatus)
  status?: PanicStatus;
}
