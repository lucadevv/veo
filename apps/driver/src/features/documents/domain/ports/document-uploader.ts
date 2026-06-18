/**
 * Puerto (DIP) para subir el binario de un documento del conductor al almacenamiento de objetos
 * soberano (S3/MinIO) vía un ticket prefirmado expedido por el driver-bff. La presentación y los
 * casos de uso dependen de esta ABSTRACCIÓN, nunca de la implementación concreta (cliente HTTP del
 * BFF + `fetch` crudo a MinIO), de modo que el flujo quede desacoplado y testeable. La implementación
 * vive en `data/` y se cablea por el contenedor de DI.
 *
 * Espeja el patrón del avatar del pasajero, pero el flujo del documento es presign → PUT → register
 * (el `register` lo hace el caso de uso con el `fileS3Key` que devuelve el ticket): el binario NUNCA
 * pasa por la API (Ley 29733: el binario es PII), va directo al almacén con los headers firmados.
 */

import type { DocumentUploadContentType } from '@veo/api-client';
import type { FleetDocumentType } from '@veo/shared-types';
import type { PickedImage } from './image-picker-service';

/** Motivo accionable por el que la subida del binario del documento falló (feedback claro). */
export type DocumentUploadFailure =
  /** El formato/MIME del archivo no está en la allowlist del contrato (jpeg/png/pdf). */
  | 'unsupported-type'
  /** El driver-bff no pudo expedir el ticket de subida prefirmado. */
  | 'presign'
  /**
   * No se pudo LEER el binario local del archivo elegido (`content://`/`file://` ilegible o
   * `.blob()` no soportado). Distinto de `network`: el fallo es de acceso al archivo, no de red.
   */
  | 'read'
  /** El almacén de objetos (S3/MinIO) rechazó el binario (status != 2xx) en el PUT. */
  | 'upload'
  /** Fallo de red durante el PUT al almacén de objetos. */
  | 'network';

/** Error de subida del binario del documento con un motivo accionable. */
export class DocumentUploadError extends Error {
  constructor(
    readonly reason: DocumentUploadFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'DocumentUploadError';
  }
}

/** `contentType` canónico derivado del archivo elegido (allowlist del contrato). */
export interface ResolvedContentType {
  contentType: DocumentUploadContentType;
}

/** Resultado de subir el binario: la key driver-scoped que luego viaja a `POST /drivers/me/documents`. */
export interface UploadedDocumentBinary {
  /** Key del objeto subido al almacén soberano (se reenvía en `fileS3Key` al registrar). */
  fileS3Key: string;
}

/** Subida del binario del documento encapsulada tras una interfaz de dominio. */
export interface DocumentUploader {
  /**
   * Sube el binario local del documento y resuelve con su `fileS3Key`. El flujo:
   *  1. Deriva el `contentType` del archivo (allowlist jpeg/png/pdf); si no casa, lanza
   *     `DocumentUploadError('unsupported-type')`.
   *  2. Pide un ticket prefirmado al driver-bff (`POST /drivers/me/documents/presign`).
   *  3. Lee el binario local (si es ilegible → `read`).
   *  4. Sube el binario crudo (PUT) DIRECTO al almacén con los `requiredHeaders` del ticket (sin el
   *     `Authorization` del BFF).
   * Lanza `DocumentUploadError` ante fallos accionables. El registro del documento (con el
   * `fileS3Key`) lo realiza el caso de uso, no este puerto.
   *
   * @param type `FleetDocumentType` canónico de `@veo/shared-types` (p. ej. `LICENSE_A1` | `SOAT` |
   *   `PROPERTY_CARD`). Tipado al enum, NO string libre: el presign valida `@IsEnum(FleetDocumentType)`,
   *   así que un valor fuera del enum es error de compilación, no un 400 en runtime.
   * @param file Imagen/archivo local elegido por el conductor.
   */
  upload(type: FleetDocumentType, file: PickedImage): Promise<UploadedDocumentBinary>;
}
