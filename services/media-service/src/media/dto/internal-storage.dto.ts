import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * TTL por defecto (segundos) de la URL prefirmada de descarga interna. Corto a propósito: la usa
 * admin-bff server-to-server para resolver un documento puntual, no para exposición prolongada.
 */
export const DEFAULT_PRESIGN_GET_TTL_SECONDS = 120;

/** Límite superior del TTL solicitable (1 hora) — evita URLs de descarga de vida larga. */
export const MAX_PRESIGN_GET_TTL_SECONDS = 3600;

/**
 * Content-Types permitidos para SUBIR un documento de flota (licencia, SOAT, tarjeta de propiedad).
 * Allowlist ÚNICA (Ley 29733: el binario es PII, no se acepta cualquier tipo): foto JPEG/PNG o PDF.
 * El Content-Type viaja firmado en la URL prefirmada, así que el PUT del cliente DEBE coincidir.
 */
export const DOCUMENT_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type DocumentUploadContentType = (typeof DOCUMENT_UPLOAD_CONTENT_TYPES)[number];

/**
 * TTL por defecto (segundos) de la URL prefirmada de SUBIDA interna. Corto a propósito: la app pide
 * el ticket justo antes de subir el binario; no debe quedar una URL de escritura de vida larga.
 */
export const DEFAULT_PRESIGN_PUT_TTL_SECONDS = 300;

/** Límite superior del TTL de subida solicitable (15 min) — acota la ventana de escritura. */
export const MAX_PRESIGN_PUT_TTL_SECONDS = 900;

/**
 * Body de `POST /media/internal/presign-get`. Server-to-server (InternalIdentityGuard): admin-bff
 * pide una URL GET prefirmada de corta vida para una key arbitraria de un bucket concreto.
 */
export class PresignGetDto {
  @ApiProperty({ description: 'Bucket S3 origen', example: 'veo-documents-dev' })
  @IsString()
  @IsNotEmpty()
  bucket!: string;

  @ApiProperty({
    description: 'Key (path) del objeto dentro del bucket',
    example: 'fleet/driver-1/license.pdf',
  })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({
    required: false,
    description: `Validez de la URL en segundos (default ${DEFAULT_PRESIGN_GET_TTL_SECONDS}, máx ${MAX_PRESIGN_GET_TTL_SECONDS})`,
    minimum: 1,
    maximum: MAX_PRESIGN_GET_TTL_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PRESIGN_GET_TTL_SECONDS)
  ttlSeconds?: number;
}

/** Respuesta: la URL prefirmada de descarga (GET). */
export interface PresignGetView {
  url: string;
}

/**
 * Body de `POST /media/internal/presign-put`. Server-to-server (InternalIdentityGuard): el driver-bff
 * pide una URL PUT prefirmada de corta vida para que la app suba el binario de un documento de flota.
 * El `contentType` se valida contra la allowlist (PII) y queda firmado en la URL.
 */
export class PresignPutDto {
  @ApiProperty({ description: 'Bucket S3 destino', example: 'veo-documents-dev' })
  @IsString()
  @IsNotEmpty()
  bucket!: string;

  @ApiProperty({
    description: 'Key (path) del objeto destino dentro del bucket (driver-scoped)',
    example: 'drivers/driver-1/documents/LICENSE_A1/0190a1b2.jpg',
  })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({
    description: 'Content-Type que el cliente DEBE enviar en el PUT (allowlist de documentos)',
    enum: DOCUMENT_UPLOAD_CONTENT_TYPES,
  })
  @IsIn(DOCUMENT_UPLOAD_CONTENT_TYPES)
  contentType!: DocumentUploadContentType;

  @ApiProperty({
    required: false,
    description: `Validez de la URL en segundos (default ${DEFAULT_PRESIGN_PUT_TTL_SECONDS}, máx ${MAX_PRESIGN_PUT_TTL_SECONDS})`,
    minimum: 1,
    maximum: MAX_PRESIGN_PUT_TTL_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PRESIGN_PUT_TTL_SECONDS)
  ttlSeconds?: number;
}

/**
 * Respuesta: la URL prefirmada de subida (PUT) + los headers que el cliente DEBE reenviar exactamente
 * (el Content-Type viaja firmado; si no coincide, S3/MinIO rechaza la subida).
 */
export interface PresignPutView {
  url: string;
  requiredHeaders: Record<string, string>;
}
