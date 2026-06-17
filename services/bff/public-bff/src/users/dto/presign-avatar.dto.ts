import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

/** Lista blanca de Content-Type de imagen aceptados para el avatar (espeja media-service). */
export const ALLOWED_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarContentType = (typeof ALLOWED_AVATAR_CONTENT_TYPES)[number];

/** Extensiones de fichero aceptadas para el avatar. */
export const ALLOWED_AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export type AvatarExtension = (typeof ALLOWED_AVATAR_EXTENSIONS)[number];

/** Body de `POST /users/me/avatar/presign`. La identidad sale del JWT, no del body. */
export class PresignAvatarUploadDto {
  @ApiProperty({ enum: ALLOWED_AVATAR_CONTENT_TYPES, description: 'Content-Type de la imagen' })
  @IsIn(ALLOWED_AVATAR_CONTENT_TYPES, { message: 'contentType no permitido (solo imágenes)' })
  contentType!: AvatarContentType;

  @ApiProperty({ enum: ALLOWED_AVATAR_EXTENSIONS, description: 'Extensión del fichero' })
  @IsIn(ALLOWED_AVATAR_EXTENSIONS, { message: 'ext no permitida' })
  ext!: AvatarExtension;
}

/** Key de avatar: `avatars/{userId}/avatar.{ext}` (determinista por usuario, espeja media-service). */
const AVATAR_KEY_PATTERN = /^avatars\/[^/]+\/avatar\.(jpg|jpeg|png|webp)$/;

/**
 * Body de `POST /users/me/avatar/confirm`. Tras el PUT, la app confirma con la `key` del ticket para
 * que media-service valide la cuota de tamaño y devuelva la `publicUrl` definitiva.
 */
export class ConfirmAvatarUploadDto {
  @ApiProperty({
    description: 'Key del objeto subido (la del ticket)',
    example: 'avatars/usr-1/avatar.jpg',
  })
  @IsString()
  @Matches(AVATAR_KEY_PATTERN, { message: 'key de avatar inválida' })
  key!: string;
}

/**
 * Ticket de subida que devuelve media-service (passthrough del public-bff). La app sube el binario
 * con un PUT a `uploadUrl` (≤ `maxBytes`) y luego confirma con POST /users/me/avatar/confirm; con la
 * confirmación OK guarda `publicUrl` en su perfil con PATCH /users/me.
 */
export interface AvatarUploadTicket {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  key: string;
  publicUrl: string;
  expiresInSeconds: number;
  /** Tamaño máximo permitido en bytes (lo valida media-service en el confirm). */
  maxBytes: number;
}

/** Respuesta de `POST /users/me/avatar/confirm`: la subida cumplió la cuota; publicUrl estable. */
export interface AvatarUploadConfirmed {
  key: string;
  publicUrl: string;
  sizeBytes: number;
}
