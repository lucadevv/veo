/**
 * InternalStorageService — emite URLs prefirmadas de descarga (GET) de corta vida para una key
 * arbitraria de un bucket concreto. Consumo server-to-server (admin-bff vía InternalIdentityGuard):
 * resolver un documento de flota puntual sin acoplar el dominio a `@aws-sdk` (el storage va detrás
 * del `StoragePort`, regla D de SOLID).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@veo/utils';
import { STORAGE_PORT, type StoragePort, type PresignAudience } from '../ports/storage/storage.port';
import {
  DEFAULT_PRESIGN_GET_TTL_SECONDS,
  DEFAULT_PRESIGN_PUT_TTL_SECONDS,
  DOCUMENT_UPLOAD_CONTENT_TYPES,
  type DocumentUploadContentType,
  type PresignGetView,
  type PresignPutView,
  type PurgeDriverDocsView,
} from './dto/internal-storage.dto';

function isAllowedContentType(value: string): value is DocumentUploadContentType {
  return (DOCUMENT_UPLOAD_CONTENT_TYPES as readonly string[]).includes(value);
}

@Injectable()
export class InternalStorageService {
  constructor(@Inject(STORAGE_PORT) private readonly storage: StoragePort) {}

  async presignGet(input: {
    bucket: string;
    key: string;
    ttlSeconds?: number;
    audience?: PresignAudience;
  }): Promise<PresignGetView> {
    const url = await this.storage.presignDownloadUrl({
      bucket: input.bucket,
      key: input.key,
      expiresSeconds: input.ttlSeconds ?? DEFAULT_PRESIGN_GET_TTL_SECONDS,
      // Audiencia: por defecto 'admin' (el visor del operador corre en el browser DEL MAC → se firma contra
      // S3_ADMIN_BASE_URL/localhost). El driver-bff (preview del onboarding en el TELÉFONO) pasa 'device' →
      // se firma contra S3_PUBLIC_BASE_URL (host LAN); si no, la URL apunta a localhost y el device no la alcanza.
      audience: input.audience ?? 'admin',
    });
    return { url };
  }

  /**
   * Emite una URL PUT prefirmada de corta vida para subir el binario de un documento de flota (PII).
   * El `contentType` se REVALIDA contra la allowlist (defensa en profundidad: el DTO ya lo valida,
   * pero el dominio no confía en que el guard de transporte lo haya hecho) y queda firmado en la URL.
   */
  async presignPut(input: {
    bucket: string;
    key: string;
    contentType: string;
    ttlSeconds?: number;
  }): Promise<PresignPutView> {
    if (!isAllowedContentType(input.contentType)) {
      throw new ValidationError('Content-Type no permitido para documentos de flota', {
        field: 'contentType',
        contentType: input.contentType,
        allowed: [...DOCUMENT_UPLOAD_CONTENT_TYPES],
      });
    }

    const url = await this.storage.presignUploadUrl({
      bucket: input.bucket,
      key: input.key,
      contentType: input.contentType,
      expiresSeconds: input.ttlSeconds ?? DEFAULT_PRESIGN_PUT_TTL_SECONDS,
    });

    // El cliente DEBE reenviar exactamente este Content-Type en el PUT (viaja firmado en la URL).
    return { url, requiredHeaders: { 'Content-Type': input.contentType } };
  }

  /**
   * HARD purge de los binarios de documentos de un conductor (re-registro): barre TODOS los objetos bajo
   * `drivers/<driverId>/` del bucket de documentos (las keys que el driver-bff firma al subir). El prefijo
   * se CONSTRUYE acá a partir del `driverId` — nunca lo manda el cliente — para que el borrado masivo no
   * pueda apuntar a un prefijo arbitrario. Idempotente: sin objetos devuelve 0.
   */
  async purgeDriverDocs(input: { bucket: string; driverId: string }): Promise<PurgeDriverDocsView> {
    if (!input.driverId) {
      throw new ValidationError('driverId requerido para el purge de documentos', {
        field: 'driverId',
      });
    }
    const prefix = `drivers/${input.driverId}/`;
    const deleted = await this.storage.deletePrefix(input.bucket, prefix);
    return { deleted };
  }
}
