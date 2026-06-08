/**
 * Puerto de almacenamiento de objetos (FOUNDATION §9). S3/MinIO self-hosted tras un puerto
 * intercambiable. El dominio depende de esta abstracción, no de `@aws-sdk` (regla D de SOLID).
 *
 * - `live`: S3Client real (forcePathStyle) contra MinIO/S3 + URLs prefirmadas.
 * - `sandbox`: adapter determinista para tests (URLs estables, sin red).
 */
export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface PresignDownloadInput {
  key: string;
  expiresSeconds: number;
}

export interface PresignUploadInput {
  /** Clave (path) del objeto destino dentro del bucket. */
  key: string;
  /** Content-Type exacto que el cliente DEBE enviar en el PUT (se firma en la URL). */
  contentType: string;
  /** Validez de la URL prefirmada en segundos. */
  expiresSeconds: number;
  /**
   * Bucket destino. Opcional: por defecto el bucket primario del adapter (video). El bucket de
   * avatares (lectura pública) se pasa explícito para no acoplar el dominio a un bucket concreto.
   */
  bucket?: string;
}

export interface StoragePort {
  /** Genera una URL prefirmada de descarga (GET) válida `expiresSeconds` (BR-S02: 5 min). */
  presignDownloadUrl(input: PresignDownloadInput): Promise<string>;
  /** Genera una URL prefirmada de subida (PUT) para que el cliente suba el objeto directamente. */
  presignUploadUrl(input: PresignUploadInput): Promise<string>;
  /**
   * Borra un objeto (barrido de retención — BR-S03; cuota de avatar). Idempotente.
   * `bucket` opcional: por defecto el bucket primario del adapter (video); el bucket de avatares se
   * pasa explícito para no acoplar el dominio a un bucket concreto.
   */
  deleteObject(key: string, bucket?: string): Promise<void>;
  /**
   * Tamaño del objeto en bytes (0 si no existe). `bucket` opcional (ver `deleteObject`): permite
   * validar la cuota del avatar en su propio bucket sin acoplar el dominio al bucket de video.
   */
  getObjectSize(key: string, bucket?: string): Promise<number>;
}
