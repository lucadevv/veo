import { NativeModules } from 'react-native';
import {
  DOCUMENT_SCANNER_ERROR_CODES,
  DocumentScannerError,
  type DocumentScanOptions,
  type DocumentScannerErrorCode,
  type DocumentScannerService,
  type ScannedDocument,
} from '../../domain/ports/document-scanner-service';

/**
 * Contrato del módulo nativo `VeoDocumentScanner` (iOS VisionKit / Android MLKit Document Scanner).
 * Lo proveen otros agentes; aquí se consume su superficie EXACTA: una llamada `scan` que abre el
 * escáner con detección de bordes + auto-captura y devuelve las imágenes croppeadas en base64 MÁS el
 * texto OCR reconocido on-device por página (`textLines`).
 */
interface NativeDocumentScannerResult {
  /** Imágenes base64 JPEG (SIN prefijo `data:`), croppeadas y corregidas, en orden de captura. */
  images: string[];
  /**
   * Líneas de texto OCR por imagen, alineadas por índice con `images`. Página sin texto → `[]`. Puede
   * faltar en builds nativos viejos (sin la capa OCR); el wrapper lo normaliza a `[]` por imagen.
   */
  textLines?: string[][];
}

interface NativeDocumentScannerModule {
  /**
   * Abre el escáner nativo. Resuelve con `{ images, textLines }`. Rechaza con un error que lleva `code`
   * (`E_CANCELLED` | `E_UNAVAILABLE` | `E_SCAN_FAILED`) y `message`.
   */
  scan(options: { maxPages?: number }): Promise<NativeDocumentScannerResult>;
}

/** Acceso tipado al módulo nativo (undefined si no está enlazado en esta plataforma/build). */
const nativeModule = NativeModules.VeoDocumentScanner as NativeDocumentScannerModule | undefined;

/** Por ahora 1 imagen por documento (el backend N-imágenes es Lote 3). */
const DEFAULT_MAX_PAGES = 1;

/** ¿El valor es un código de error conocido del escáner? (narrowing del rechazo nativo crudo). */
function asScannerErrorCode(value: unknown): DocumentScannerErrorCode | null {
  return DOCUMENT_SCANNER_ERROR_CODES.includes(value as DocumentScannerErrorCode)
    ? (value as DocumentScannerErrorCode)
    : null;
}

/**
 * Normaliza CUALQUIER rechazo del módulo nativo a un `DocumentScannerError` tipado. El bridge de RN
 * entrega los reject como un objeto con `code`/`message`; si llegara algo inesperado, lo tratamos como
 * `E_SCAN_FAILED` (default seguro: nunca un éxito silencioso ni un código inventado).
 */
function toScannerError(error: unknown): DocumentScannerError {
  if (error instanceof DocumentScannerError) {
    return error;
  }
  const raw = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = asScannerErrorCode(raw?.code) ?? 'E_SCAN_FAILED';
  const message = typeof raw?.message === 'string' ? raw.message : undefined;
  return new DocumentScannerError(code, message);
}

/**
 * Implementación del escáner de documentos sobre el módulo nativo `VeoDocumentScanner`.
 *
 * El nativo es el único dueño de la cámara durante el escaneo (abre y libera la sesión por llamada) y
 * devuelve las imágenes YA croppeadas/corregidas. Si el módulo no está enlazado en este build/device,
 * lanza `E_UNAVAILABLE` para que la presentación caiga honestamente a la galería: nunca devuelve una
 * imagen vacía o simulada.
 */
export class NativeDocumentScanner implements DocumentScannerService {
  async scan(options?: DocumentScanOptions): Promise<ScannedDocument> {
    if (!nativeModule) {
      throw new DocumentScannerError('E_UNAVAILABLE');
    }
    let result: NativeDocumentScannerResult;
    try {
      result = await nativeModule.scan({ maxPages: options?.maxPages ?? DEFAULT_MAX_PAGES });
    } catch (error) {
      throw toScannerError(error);
    }
    const images = result?.images;
    if (!Array.isArray(images) || images.length === 0) {
      // El nativo siempre debe devolver imágenes reales cuando resuelve; un vacío es un fallo de captura.
      throw new DocumentScannerError('E_SCAN_FAILED', 'El escaneo no produjo imágenes');
    }
    return { images, textLines: alignTextLines(result?.textLines, images.length) };
  }
}

/**
 * Alinea `textLines` con `images` por índice: garantiza una entrada por imagen. Un build nativo viejo
 * (sin OCR) o una respuesta con menos arrays se rellenan con `[]` (página sin texto) — la captura sigue
 * siendo válida, solo no habrá auto-llenado. Cualquier entrada que no sea un array de strings se sanea a
 * `[]` (default seguro: nunca propaga basura al parser, que asume `string[]`).
 */
function alignTextLines(textLines: unknown, imageCount: number): string[][] {
  const source = Array.isArray(textLines) ? textLines : [];
  const aligned: string[][] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const page = source[i];
    aligned.push(
      Array.isArray(page) ? page.filter((line): line is string => typeof line === 'string') : [],
    );
  }
  return aligned;
}

/** Singleton del escáner nativo de documentos para inyectar en la capa de presentación. */
export const nativeDocumentScanner: DocumentScannerService = new NativeDocumentScanner();

/**
 * `true` si el módulo nativo del escáner está enlazado en este build/plataforma. Es `false` en el
 * SIMULADOR / builds sin el módulo. La presentación puede usarlo para anticipar la ausencia, pero el
 * fallback REAL se decide al recibir `E_UNAVAILABLE` (no se confía solo en este flag).
 */
export const nativeDocumentScannerLinked: boolean = nativeModule !== undefined;
