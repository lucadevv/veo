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
import type { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { PickedImage } from './image-picker-service';

/**
 * Fase de ENVÍO de UNA CARA del documento (la señal que pintan el sheet y las cards del alta:
 * "Subiendo… / Enviado ✓ / Error"). Vive en el DOMINIO (no en la capa de presentación) para que el
 * puerto de subida pueda reportarla por cara SIN crear una dependencia inversa domain→presentation:
 * el store del wizard la RE-EXPORTA para el resto de la app. Union TIPADA, sin strings mágicos sueltos.
 *  - `idle`: la cara aún no empezó a subir (o no aplica: p. ej. el reverso de un doc de 1 cara).
 *  - `sending`: el PUT del binario de esa cara está en vuelo.
 *  - `sent`: el binario de esa cara ya está en el almacén soberano (PUT OK).
 *  - `error`: el PUT de esa cara falló.
 */
export type DocumentSendPhase = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Callback OPCIONAL para reportar la fase de envío de CADA cara mientras la subida progresa (presign→
 * PUT por cara). El orquestador (hook) lo usa para reflejar el avance por-cara en el store/UI en vivo:
 * `sending` antes del PUT de la cara, `sent` tras el PUT OK, `error` si el PUT de esa cara falló. Sin el
 * callback, el comportamiento de la subida es IDÉNTICO (backward-compatible).
 */
export type DocumentSidePhaseCallback = (side: DocumentSide, phase: DocumentSendPhase) => void;

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

/** Una CARA del documento a subir: la imagen local + el lado tipado (FRONT/BACK/SINGLE) que ocupa. */
export interface DocumentSideFile {
  /** Cara del documento (sub-lote 3A): `SINGLE` para 1 imagen; `FRONT`/`BACK` para el DNI. */
  side: DocumentSide;
  /** Imagen/archivo local capturado/elegido para esa cara. */
  file: PickedImage;
}

/** Una imagen ya subida: su key driver-scoped + la cara que ocupa, lista para `images` del registro. */
export interface UploadedDocumentImage {
  /** Key del objeto subido al almacén soberano (viaja en `images[].s3Key` al registrar). */
  s3Key: string;
  /** Cara del documento a la que corresponde la imagen (FRONT/BACK/SINGLE). */
  side: DocumentSide;
}

/**
 * Resultado de subir el binario del documento: las imágenes subidas (1..N caras), cada una con su key
 * y su cara. El caso de uso las reenvía como `images: [{ s3Key, side }]` a `POST /drivers/me/documents`.
 */
export interface UploadedDocumentBinary {
  /** Imágenes subidas (una por cara), alineadas con las caras pedidas. Para 1 imagen, un solo SINGLE. */
  images: UploadedDocumentImage[];
}

/** Subida del binario del documento encapsulada tras una interfaz de dominio. */
export interface DocumentUploader {
  /**
   * Sube los binarios locales del documento (1..N caras) y resuelve con sus `s3Key` por cara. El flujo:
   *  1. Deriva el `contentType` de cada archivo (allowlist jpeg/png/pdf); si no casa, lanza
   *     `DocumentUploadError('unsupported-type')`.
   *  2. Pide los tickets prefirmados al driver-bff (`POST /drivers/me/documents/presign`) con las `sides`.
   *  3. Lee cada binario local (si es ilegible → `read`).
   *  4. Sube cada binario crudo (PUT) DIRECTO al almacén con los `requiredHeaders` de su ticket (sin el
   *     `Authorization` del BFF), emparejando ticket↔archivo por `side`.
   * Lanza `DocumentUploadError` ante fallos accionables. El registro del documento (con las `images`)
   * lo realiza el caso de uso, no este puerto.
   *
   * @param type `FleetDocumentType` canónico de `@veo/shared-types` (p. ej. `LICENSE_A1` | `SOAT` |
   *   `PROPERTY_CARD` | `DNI`). Tipado al enum, NO string libre: el presign valida
   *   `@IsEnum(FleetDocumentType)`, así que un valor fuera del enum es error de compilación, no un 400.
   * @param sides Las caras a subir, cada una con su archivo local. 1 imagen → `[{ side: 'SINGLE', file }]`;
   *   DNI → `[{ side: 'FRONT', file }, { side: 'BACK', file }]`. NO vacío.
   * @param onSidePhase Callback OPCIONAL de fase POR CARA (`sending`→`sent`/`error`) para reflejar el
   *   avance en vivo. Sin él, la subida se comporta EXACTAMENTE igual (backward-compatible).
   */
  upload(
    type: FleetDocumentType,
    sides: DocumentSideFile[],
    onSidePhase?: DocumentSidePhaseCallback,
  ): Promise<UploadedDocumentBinary>;
}
