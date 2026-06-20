import type { FleetDocumentType } from '@veo/shared-types';
import type { ExtractedDocumentData, OcrEngineValue } from '@veo/api-client';
import type { DriverDocument, RegisterDocumentInput } from '../entities';
import type {
  DocumentSideFile,
  DocumentUploader,
  UploadedDocumentBinary,
} from '../ports/document-uploader';

/**
 * Metadatos que el formulario ya captura para un documento (número + vencimiento opcional). El tipo
 * NO va aquí: lo fija la tarjeta del paso de documentos y se pasa por separado al ejecutar.
 */
export interface DocumentMetadata {
  /** Número del documento. Opcional POR TIPO: la foto del vehículo (VEHICLE_PHOTO) no lo tiene. */
  documentNumber?: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAt?: string;
  /**
   * Onboarding sin-formularios (Lote 1): data extraída por OCR on-device (unión discriminada por `type`).
   * El cliente la PRODUCE del escaneo (mapper `parsedXToExtracted`) y la envía al backend, que la persiste
   * para que el operador la re-verifique. Opcional: registrar sin OCR sigue siendo válido (degradación).
   */
  extractedData?: ExtractedDocumentData;
  /** Motor de OCR que produjo `extractedData` (enum cerrado). Trazabilidad. Solo si hay `extractedData`. */
  ocrEngine?: OcrEngineValue;
  /** Instante de la extracción OCR (ISO-8601). Solo si hay `extractedData`. */
  ocrAt?: string;
}

/** Puerto mínimo de registro: registra/actualiza el documento con su `fileS3Key` ya subido. */
export interface DocumentRegistrar {
  register(input: RegisterDocumentInput): Promise<DriverDocument>;
}

/**
 * Entrada del orquestador: el tipo de documento (fleet), las CARAS ya capturadas/elegidas por el
 * conductor (1..N) y los metadatos del formulario. La SELECCIÓN del archivo (cámara/galería/escáner) la
 * hace la presentación con el `ImagePickerService`/`DocumentScannerService` ANTES de invocar el caso de
 * uso, para mantener el flujo de UI (preview + reintento de captura) fuera del dominio.
 */
export interface UploadAndRegisterDocumentInput {
  /** `FleetDocumentType` canónico (p. ej. `LICENSE_A1` | `SOAT` | `PROPERTY_CARD` | `DNI`), no string libre. */
  type: FleetDocumentType;
  /**
   * Caras a subir, cada una con su archivo local. 1 imagen → `[{ side: 'SINGLE', file }]`; DNI →
   * `[{ side: 'FRONT', file }, { side: 'BACK', file }]`. NO vacío.
   */
  sides: DocumentSideFile[];
  /** Metadatos del formulario (número + vencimiento). */
  metadata: DocumentMetadata;
}

/**
 * Caso de uso: SUBE el binario del documento al almacén soberano y luego lo REGISTRA con la
 * `fileS3Key` resultante. Orquesta el puerto de subida (presign → PUT) y el registrador
 * (`POST /drivers/me/documents`), surfaceando los errores tipados de cada etapa sin "fingir" éxito:
 * si el PUT falla, NUNCA se llama a `register` (no quedaría un documento sin binario real).
 *
 * El `pick` (cámara/galería) NO vive aquí: la presentación lo ejecuta antes para poder previsualizar
 * la imagen y permitir recapturar; este caso de uso parte de un archivo ya elegido.
 */
export class UploadAndRegisterDocumentUseCase {
  constructor(
    private readonly uploader: DocumentUploader,
    private readonly registrar: DocumentRegistrar,
  ) {}

  async execute(input: UploadAndRegisterDocumentInput): Promise<DriverDocument> {
    // 1) Sube los binarios al almacén soberano (presign + PUT crudo por cara). Propaga `DocumentUploadError`.
    const uploaded: UploadedDocumentBinary = await this.uploader.upload(input.type, input.sides);

    // 2) Registra el documento CON las keys reales de los binarios subidos (1..N caras). Solo se llega
    //    aquí si TODOS los PUT fueron OK: jamás registramos un documento cuyo binario no se subió
    //    (honestidad de estado).
    return this.registrar.register({
      type: input.type,
      ...(input.metadata.documentNumber ? { documentNumber: input.metadata.documentNumber } : {}),
      ...(input.metadata.expiresAt ? { expiresAt: input.metadata.expiresAt } : {}),
      // Lote 1: la data OCR + su trazabilidad viajan SOLO si el escaneo las produjo (spread condicional,
      // igual que número/vencimiento). Un registro sin OCR sigue siendo válido (sin estas claves).
      ...(input.metadata.extractedData ? { extractedData: input.metadata.extractedData } : {}),
      ...(input.metadata.ocrEngine ? { ocrEngine: input.metadata.ocrEngine } : {}),
      ...(input.metadata.ocrAt ? { ocrAt: input.metadata.ocrAt } : {}),
      images: uploaded.images.map(({ s3Key, side }) => ({ s3Key, side })),
    });
  }
}
