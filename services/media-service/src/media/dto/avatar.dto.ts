import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

/** Lista blanca de Content-Type permitidos para el avatar (solo imágenes). */
export const ALLOWED_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarContentType = (typeof ALLOWED_AVATAR_CONTENT_TYPES)[number];

/** Extensiones de fichero permitidas para la key del avatar. */
export const ALLOWED_AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export type AvatarExtension = (typeof ALLOWED_AVATAR_EXTENSIONS)[number];

/**
 * Body de `POST /media/avatars/presign`. La identidad sale del usuario autenticado (no del body).
 * La coherencia contentType↔ext se valida en el service (regla de negocio, no de forma).
 */
export class PresignAvatarUploadDto {
  @ApiProperty({
    enum: ALLOWED_AVATAR_CONTENT_TYPES,
    description: 'Content-Type de la imagen a subir (lista blanca)',
  })
  @IsIn(ALLOWED_AVATAR_CONTENT_TYPES, { message: 'contentType no permitido (solo imágenes)' })
  contentType!: AvatarContentType;

  @ApiProperty({
    enum: ALLOWED_AVATAR_EXTENSIONS,
    description: 'Extensión del fichero del avatar',
  })
  @IsIn(ALLOWED_AVATAR_EXTENSIONS, { message: 'ext no permitida' })
  ext!: AvatarExtension;
}

/** Key de avatar: `avatars/{userId}/avatar.{ext}` (determinista por usuario, sin huérfanos). */
const AVATAR_KEY_PATTERN = /^avatars\/[^/]+\/avatar\.(jpg|jpeg|png|webp)$/;

/**
 * Body de `POST /media/avatars/confirm`. Tras el PUT, el cliente confirma con la `key` recibida en el
 * presign para que el servicio valide el tamaño real (cuota) y devuelva la `publicUrl` definitiva.
 */
export class ConfirmAvatarUploadDto {
  @ApiProperty({
    description: 'Key del objeto subido (la devuelta por el presign)',
    example: 'avatars/usr-1/avatar.jpg',
  })
  @IsString()
  @Matches(AVATAR_KEY_PATTERN, { message: 'key de avatar inválida' })
  key!: string;
}

/** Ticket de subida que devuelve el endpoint: la app sube a `uploadUrl` y guarda `publicUrl`. */
export interface AvatarUploadTicketView {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  key: string;
  publicUrl: string;
  expiresInSeconds: number;
  /** Tamaño máximo permitido en bytes (se valida en `confirm`, no en el presign). */
  maxBytes: number;
}

/** Respuesta de `POST /media/avatars/confirm`: la subida cumplió la cuota y la URL pública es estable. */
export interface AvatarUploadConfirmedView {
  key: string;
  publicUrl: string;
  sizeBytes: number;
}
