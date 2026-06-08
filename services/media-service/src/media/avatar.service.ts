/**
 * AvatarService — subida del avatar del pasajero/conductor vía presigned upload (PUT directo).
 *
 * Flujo:
 *  1. El cliente pide un ticket de subida (`presign`, identidad propagada por el BFF).
 *  2. Sube el binario con un PUT a `uploadUrl` enviando exactamente el `Content-Type` firmado.
 *  3. Confirma la subida (`confirm`): este servicio valida el TAMAÑO real del objeto con HeadObject
 *     (getObjectSize) y, si excede `AVATAR_MAX_BYTES`, BORRA el objeto y rechaza (BR de cuota).
 *  4. Con la confirmación OK, guarda la `publicUrl` estable en su perfil vía `PATCH /users/me`.
 *
 * Por qué validar el tamaño en `confirm` y no en el presign: una URL prefirmada de S3 (PUT) NO puede
 * acotar el `Content-Length` (eso solo lo permite una POST policy con `content-length-range`, que
 * cambiaría el contrato del cliente de PUT a multipart). Validar tras la subida con el `getObjectSize`
 * existente acota el tamaño sin romper el flujo PUT de las apps y deja el bucket limpio (borra el
 * objeto sobredimensionado en el acto).
 *
 * Key DETERMINISTA por usuario (`avatars/{userId}/avatar.{ext}`): cada subida SOBRESCRIBE la anterior,
 * así no se acumulan huérfanos (a lo sumo queda un objeto residual si el usuario cambia de extensión,
 * acotado a 1 por usuario; no crece sin límite como ocurría con un uuid por subida).
 *
 * El bucket de avatares es de LECTURA PÚBLICA (solo en el prefijo `avatars/`), por eso la `publicUrl`
 * es directa (sin firma). El almacenamiento va detrás del `StoragePort` (regla D de SOLID): el
 * dominio no conoce `@aws-sdk`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '@veo/utils';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import {
  type AvatarContentType,
  type AvatarExtension,
  type AvatarUploadConfirmedView,
  type AvatarUploadTicketView,
} from './dto/avatar.dto';
import type { Env } from '../config/env.schema';

export interface CreateAvatarUploadInput {
  /** Usuario propietario del avatar (del token interno propagado). */
  userId: string;
  contentType: AvatarContentType;
  ext: AvatarExtension;
}

export interface ConfirmAvatarUploadInput {
  /** Usuario propietario del avatar (del token interno propagado). */
  userId: string;
  /** Key devuelta en el ticket de presign; debe pertenecer al propio usuario (BR de propiedad). */
  key: string;
}

/** Extensiones válidas por cada Content-Type (coherencia contentType↔ext). */
const EXT_BY_CONTENT_TYPE: Record<AvatarContentType, readonly AvatarExtension[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

/// Todas las extensiones posibles de un avatar (el StoragePort no expone listado por prefijo, así
/// que el borrado del derecho al olvido recorre las extensiones conocidas — a lo sumo 1 objeto real).
const ALL_AVATAR_EXTENSIONS: readonly AvatarExtension[] = ['jpg', 'jpeg', 'png', 'webp'];

@Injectable()
export class AvatarService {
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly uploadTtl: number;
  private readonly maxBytes: number;

  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    config: ConfigService<Env, true>,
  ) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET_AVATAR');
    // Sin barra final para componer la publicUrl path-style de forma estable.
    this.publicBaseUrl = config.getOrThrow<string>('S3_PUBLIC_BASE_URL').replace(/\/$/, '');
    this.uploadTtl = config.getOrThrow<number>('SIGNED_URL_TTL_SECONDS');
    this.maxBytes = config.getOrThrow<number>('AVATAR_MAX_BYTES');
  }

  /** Genera un ticket de subida prefirmado para el avatar del usuario. */
  async createUploadTicket(input: CreateAvatarUploadInput): Promise<AvatarUploadTicketView> {
    this.assertConsistent(input.contentType, input.ext);

    // Key determinista por usuario: la subida SOBRESCRIBE la anterior (sin huérfanos acumulados).
    const key = this.keyFor(input.userId, input.ext);
    const uploadUrl = await this.storage.presignUploadUrl({
      key,
      contentType: input.contentType,
      expiresSeconds: this.uploadTtl,
      bucket: this.bucket,
    });

    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      key,
      publicUrl: this.publicUrlFor(key),
      expiresInSeconds: this.uploadTtl,
      maxBytes: this.maxBytes,
    };
  }

  /**
   * Confirma la subida validando el tamaño real del objeto (cuota AVATAR_MAX_BYTES). Si el objeto no
   * existe (0 bytes) o excede el límite, se borra (idempotente) y se rechaza con ValidationError, de
   * modo que el bucket nunca retiene un avatar fuera de cuota. Devuelve la `publicUrl` estable.
   */
  async confirmUpload(input: ConfirmAvatarUploadInput): Promise<AvatarUploadConfirmedView> {
    this.assertOwnsKey(input.userId, input.key);

    const sizeBytes = await this.storage.getObjectSize(input.key, this.bucket);

    if (sizeBytes <= 0) {
      throw new ValidationError('No se encontró el objeto subido (sube el binario antes de confirmar)', {
        field: 'key',
        key: input.key,
      });
    }

    if (sizeBytes > this.maxBytes) {
      // Borra el objeto sobredimensionado para no dejar basura en el bucket público.
      await this.storage.deleteObject(input.key, this.bucket);
      throw new ValidationError('El avatar excede el tamaño máximo permitido', {
        field: 'size',
        sizeBytes,
        maxBytes: this.maxBytes,
      });
    }

    return {
      key: input.key,
      publicUrl: this.publicUrlFor(input.key),
      sizeBytes,
    };
  }

  /**
   * Derecho al olvido (Ley 29733, evento `user.deleted`): borra el avatar del usuario del bucket
   * público. El avatar es PII (foto de la persona) con key DETERMINISTA por usuario, así que se
   * borra sin estado intermedio recorriendo las extensiones conocidas. Idempotente: `deleteObject`
   * es no-op si el objeto no existe, por lo que reprocesar el evento no falla.
   *
   * Devuelve cuántas keys se intentaron borrar (constante = nº de extensiones conocidas).
   */
  async eraseUser(userId: string): Promise<{ deletedKeys: number }> {
    const keys = ALL_AVATAR_EXTENSIONS.map((ext) => this.keyFor(userId, ext));
    await Promise.all(keys.map((key) => this.storage.deleteObject(key, this.bucket)));
    return { deletedKeys: keys.length };
  }

  /** Key determinista por usuario y extensión (`avatars/{userId}/avatar.{ext}`). */
  private keyFor(userId: string, ext: AvatarExtension): string {
    return `avatars/${userId}/avatar.${ext}`;
  }

  /** publicUrl estable path-style en el bucket de avatares (lectura pública sin firma). */
  private publicUrlFor(key: string): string {
    return `${this.publicBaseUrl}/${this.bucket}/${key}`;
  }

  /** Valida que la extensión sea coherente con el Content-Type declarado (BR de integridad). */
  private assertConsistent(contentType: AvatarContentType, ext: AvatarExtension): void {
    if (!EXT_BY_CONTENT_TYPE[contentType].includes(ext)) {
      throw new ValidationError('La extensión no coincide con el contentType', {
        field: 'ext',
        contentType,
        ext,
      });
    }
  }

  /** Garantiza que la key pertenezca al usuario autenticado (no se confirma la key de otro). */
  private assertOwnsKey(userId: string, key: string): void {
    if (!key.startsWith(`avatars/${userId}/`)) {
      throw new ValidationError('La key no pertenece al usuario autenticado', { field: 'key', key });
    }
  }
}
