/**
 * Puerto de almacenamiento de objetos (FOUNDATION §9). S3/MinIO self-hosted tras un puerto
 * intercambiable. El dominio depende de esta abstracción, no de `@aws-sdk` (regla D de SOLID).
 *
 * - `live`: S3Client real (forcePathStyle) contra MinIO/S3 + URLs prefirmadas.
 * - `sandbox`: adapter determinista para tests (URLs estables, sin red).
 *
 * La interfaz habla en tipos del CORE de Node (`Readable`/`Buffer`), nunca en tipos de `@aws-sdk`
 * (regla D de SOLID): el SDK de S3 vive SOLO dentro del adapter `live`.
 */
import type { Readable } from 'node:stream';

export const STORAGE_PORT = Symbol('STORAGE_PORT');

/**
 * Audiencia que CONSUMIRÁ la URL prefirmada. Decide contra qué host se firma (SigV4 firma el host EN
 * la firma: no se puede intercambiar a posteriori sin romperla → el host debe ser correcto al firmar):
 *  - `'device'` (default): la app del conductor/pasajero (teléfono físico). Alcanza MinIO por la IP
 *    LAN del Mac → se firma contra `S3_PUBLIC_BASE_URL`.
 *  - `'admin'`: el operador en el browser DEL MAC (admin-web vía admin-bff). Alcanza MinIO por
 *    `localhost` (estable, no driftea con DHCP) → se firma contra `S3_ADMIN_BASE_URL`.
 */
export const PRESIGN_AUDIENCES = ['device', 'admin'] as const;
export type PresignAudience = (typeof PRESIGN_AUDIENCES)[number];

export interface PresignDownloadInput {
  key: string;
  expiresSeconds: number;
  /**
   * Bucket origen. Opcional: por defecto el bucket primario del adapter (video). Se pasa explícito
   * (p. ej. el bucket de documentos de flota) para no acoplar el dominio a un bucket concreto.
   */
  bucket?: string;
  /**
   * Quién consumirá la URL (ver `PresignAudience`). Opcional; por defecto `'device'` para no cambiar
   * el comportamiento de los llamadores existentes (app/teléfono). El visor del operador (admin-bff)
   * pasa `'admin'` para firmar contra un host browser-reachable desde el Mac (localhost).
   */
  audience?: PresignAudience;
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
  /**
   * Quién consumirá la URL (ver `PresignAudience`). Opcional; por defecto `'device'`: la subida la
   * hace la app del conductor/pasajero (teléfono → host LAN).
   */
  audience?: PresignAudience;
}

/**
 * Subida server-to-server (money-side: la inicia ESTE servicio, no el cliente). La usa el quemado de
 * watermark para guardar la copia derivada del video. Tipos del core de Node: el dominio no ve `@aws-sdk`.
 */
export interface UploadObjectInput {
  /** Clave (path) del objeto destino dentro del bucket. */
  key: string;
  /**
   * Cuerpo a subir. `Buffer` cuando el largo se conoce de antemano; `Readable` para alimentar la
   * subida por pipe (p. ej. la salida de ffmpeg) sin materializar todo el video en memoria.
   */
  body: Readable | Buffer;
  /** Content-Type exacto del objeto derivado (p. ej. `video/mp4`). */
  contentType: string;
  /**
   * Bucket destino. Opcional: por defecto el bucket primario del adapter (video). Se pasa explícito
   * para no acoplar el dominio a un bucket concreto (mismo contrato que el resto del puerto).
   */
  bucket?: string;
  /**
   * Largo en bytes del `body`, si se conoce. Con un `Readable` de largo DESCONOCIDO se omite y el
   * adapter `live` cae a subida multipart (lib-storage), que no exige `Content-Length` por adelantado.
   */
  contentLength?: number;
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
  /**
   * Borra TODOS los objetos bajo un prefijo (ListObjectsV2 + DeleteObjects, paginado). Idempotente:
   * un prefijo sin objetos devuelve 0. Lo usa el HARD purge del conductor (admin-bff) para barrer
   * `drivers/<userId>/` del bucket de documentos. `bucket` es OBLIGATORIO acá (a diferencia de
   * deleteObject): un borrado masivo por prefijo NUNCA debe caer al bucket por defecto por descuido.
   * @returns cuántos objetos se borraron.
   */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
  /**
   * Descarga server-to-server: devuelve el stream de LECTURA del objeto crudo (GetObject del cliente
   * INTERNO, sin presign) para alimentar ffmpeg por pipe sin materializar el video en memoria. Lanza
   * `NotFoundError` si el objeto no existe. `bucket` opcional: por defecto el bucket primario del adapter.
   */
  getObjectStream(key: string, bucket?: string): Promise<Readable>;
  /**
   * Subida server-to-server: guarda un objeto desde el SERVIDOR (PutObject del cliente INTERNO, sin
   * presign) — p. ej. la copia con watermark quemado. Ver `UploadObjectInput`.
   */
  uploadObject(input: UploadObjectInput): Promise<void>;
}
