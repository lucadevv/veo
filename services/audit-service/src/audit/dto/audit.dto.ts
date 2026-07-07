import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RecordAuditDto {
  // INTEGRIDAD del WORM (Ley 29733): el actor NO se acepta del body — se DERIVA de la identidad interna
  // VERIFICADA por el InternalIdentityGuard (firma HMAC). Un caller no puede forjar quién hizo la acción.
  // (Con `whitelist: true` en el ValidationPipe, un `actorId` enviado por error se descarta en silencio.)

  @ApiProperty({ example: 'media.access', description: 'Acción auditada.' })
  @IsString()
  @MinLength(1)
  action!: string;

  @ApiProperty({ example: 'media', description: 'Tipo de recurso afectado.' })
  @IsString()
  @MinLength(1)
  resourceType!: string;

  @ApiProperty({ example: 'trip_01J...', description: 'Id del recurso afectado.' })
  @IsString()
  @MinLength(1)
  resourceId!: string;

  @ApiPropertyOptional({ type: Object, description: 'Detalle de la acción (jsonb).' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  // IDEMPOTENCIA del registro síncrono (espejo del carril Kafka): id ESTABLE del evento (UUIDv7)
  // generado por el caller UNA vez por acción. Un retry de TRANSPORTE reusa el mismo id → el append-only
  // dedupea por eventId y no duplica la fila WORM. Omitir = caller legacy: el servicio genera uno (no
  // idempotente). El retry a nivel OPERACIÓN-BFF (doble-submit del operador) es otro tema (idempotency
  // keys en las mutaciones admin) — fuera de scope de este campo.
  @ApiPropertyOptional({
    description: 'Id estable del evento (UUIDv7) para idempotencia del registro.',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;
}

export class QueryAuditDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor: devuelve entradas con seq < beforeSeq.' })
  @IsOptional()
  @IsString()
  beforeSeq?: string;
}

export class VerifyAuditDto {
  @ApiPropertyOptional({ description: 'seq inicial del rango (incluido). Omitir = desde GENESIS.' })
  @IsOptional()
  @IsString()
  fromSeq?: string;

  @ApiPropertyOptional({ description: 'seq final del rango (incluido). Omitir = hasta el final.' })
  @IsOptional()
  @IsString()
  toSeq?: string;
}

export class AuditEntryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Orden monotónico de la cadena.' }) seq!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty() action!: string;
  @ApiProperty() resourceType!: string;
  @ApiProperty() resourceId!: string;
  @ApiProperty() ip!: string;
  @ApiProperty() userAgent!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ type: Object }) payload!: Record<string, unknown>;
  @ApiProperty({ nullable: true }) prevHash!: string | null;
  @ApiProperty() hash!: string;
  @ApiProperty({
    nullable: true,
    description: 'Clave del objeto WORM en S3 (null si aún no replicado).',
  })
  s3ObjectKey!: string | null;
  @ApiProperty() createdAt!: string;
}

export class VerifyResponse {
  @ApiProperty() valid!: boolean;
  @ApiProperty() checked!: number;
  @ApiProperty({ nullable: true }) fromSeq!: string | null;
  @ApiProperty({ nullable: true }) toSeq!: string | null;
  @ApiPropertyOptional() brokenAtSeq?: string;
  @ApiPropertyOptional() reason?: string;
}
