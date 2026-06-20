/**
 * Puerto (DIP) para ESCANEAR un documento con la cámara nativa (detección de bordes + auto-captura +
 * corrección de perspectiva). La presentación y los casos de uso dependen de esta ABSTRACCIÓN, nunca
 * del módulo nativo concreto (`NativeModules.VeoDocumentScanner`), de modo que el flujo quede
 * desacoplado y testeable (se inyecta un fake en tests). La implementación REAL vive en `data/` y se
 * cablea por el contenedor de DI.
 *
 * A diferencia del `ImagePickerService` (galería/cámara plana), el escáner croppea y corrige el
 * documento ANTES de devolverlo: el conductor obtiene una foto recortada y legible sin reencuadrar a
 * mano. El nativo (iOS VisionKit / Android MLKit) lo proveen otros agentes; este puerto consume su
 * contrato EXACTO.
 */

/**
 * Códigos de fallo del escáner, tipados como union (nunca strings mágicos sueltos en el flujo):
 *  - `E_CANCELLED`: el conductor cerró el escáner sin capturar. NO es un fallo (se trata como cancelar).
 *  - `E_UNAVAILABLE`: el módulo nativo no está enlazado/soportado en este device o build. Habilita el
 *    fallback honesto a la galería (no se inventa una captura).
 *  - `E_SCAN_FAILED`: la cámara/escáner falló durante la captura (hardware, permiso, proceso interno).
 */
export type DocumentScannerErrorCode = 'E_CANCELLED' | 'E_UNAVAILABLE' | 'E_SCAN_FAILED';

/** Conjunto de códigos válidos para narrowing seguro de un rechazo nativo desconocido. */
export const DOCUMENT_SCANNER_ERROR_CODES: readonly DocumentScannerErrorCode[] = [
  'E_CANCELLED',
  'E_UNAVAILABLE',
  'E_SCAN_FAILED',
] as const;

/**
 * Error tipado del escáner. Lleva el `code` canónico para que la presentación decida sin comparar
 * strings sueltos: `E_CANCELLED` ⇒ no-error (cancelar), `E_UNAVAILABLE` ⇒ fallback a galería,
 * `E_SCAN_FAILED` ⇒ banner de error con reintento.
 */
export class DocumentScannerError extends Error {
  constructor(
    readonly code: DocumentScannerErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DocumentScannerError';
  }
}

/** Type guard: ¿es un `DocumentScannerError` con un código concreto? Evita comparaciones de string sueltas. */
export function isDocumentScannerError(
  error: unknown,
  code?: DocumentScannerErrorCode,
): error is DocumentScannerError {
  if (!(error instanceof DocumentScannerError)) {
    return false;
  }
  return code === undefined || error.code === code;
}

/** Opciones del escaneo (la implementación aplica defaults sensatos). */
export interface DocumentScanOptions {
  /**
   * Máximo de páginas/imágenes a capturar en una misma sesión. Por ahora el flujo del alta consume
   * 1 imagen por documento (el backend N-imágenes es Lote 3), así que el default es 1.
   */
  maxPages?: number;
}

/**
 * Resultado del escaneo: las imágenes capturadas y el TEXTO OCR reconocido on-device por página.
 *  - `images[i]`: base64 JPEG (SIN prefijo `data:`), croppeada y corregida, en orden de captura.
 *  - `textLines[i]`: líneas de texto OCR de `images[i]`, en orden de lectura. El nativo (Vision iOS /
 *    MLKit Text Android) las extrae en el device — NO viaja la imagen a un tercero. Una página sin texto
 *    reconocible trae un array vacío. La presentación pasa `textLines[0]` al parser para auto-llenar.
 *
 * INVARIANTE: `images` y `textLines` tienen la MISMA longitud y se alinean por índice. Si el nativo
 * devolviera menos líneas que imágenes (build viejo sin OCR), la implementación rellena con `[]` para no
 * romper la alineación (degradación honesta: sin texto → sin auto-llenado, captura igual válida).
 */
export interface ScannedDocument {
  /** Imágenes base64 JPEG (sin prefijo `data:`), en orden de captura. Nunca vacío cuando resuelve. */
  images: string[];
  /** Líneas de texto OCR por imagen, alineadas por índice con `images`. Página sin texto → `[]`. */
  textLines: string[][];
}

/** Escaneo de documento encapsulado tras una interfaz de dominio. */
export interface DocumentScannerService {
  /**
   * Abre el escáner nativo y resuelve con las imágenes capturadas (base64 JPEG SIN prefijo `data:`,
   * croppeadas y corregidas, en orden de captura) MÁS el texto OCR reconocido on-device por página.
   * NUNCA devuelve datos simulados.
   *
   * Lanza `DocumentScannerError`:
   *  - `E_CANCELLED` si el conductor cerró el escáner (la presentación lo trata como cancelar, no error).
   *  - `E_UNAVAILABLE` si el módulo nativo no está disponible (la presentación cae a la galería).
   *  - `E_SCAN_FAILED` ante un fallo real de captura.
   */
  scan(options?: DocumentScanOptions): Promise<ScannedDocument>;
}
