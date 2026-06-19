import type { FleetDocumentType } from '@veo/shared-types';
import type { DriverDocument, RegisterDocumentInput } from '../entities';
import type { DocumentUploader, UploadedDocumentBinary } from '../ports/document-uploader';
import type { PickedImage } from '../ports/image-picker-service';

/**
 * Metadatos que el formulario ya captura para un documento (número + vencimiento opcional). El tipo
 * NO va aquí: lo fija la tarjeta del paso de documentos y se pasa por separado al ejecutar.
 */
export interface DocumentMetadata {
  /** Número del documento. Opcional POR TIPO: la foto del vehículo (VEHICLE_PHOTO) no lo tiene. */
  documentNumber?: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAt?: string;
}

/** Puerto mínimo de registro: registra/actualiza el documento con su `fileS3Key` ya subido. */
export interface DocumentRegistrar {
  register(input: RegisterDocumentInput): Promise<DriverDocument>;
}

/**
 * Entrada del orquestador: el tipo de documento (fleet), el archivo local ya elegido por el
 * conductor y los metadatos del formulario. La SELECCIÓN del archivo (cámara/galería) la hace la
 * presentación con el `ImagePickerService` ANTES de invocar el caso de uso, para mantener el flujo
 * de UI (preview + reintento de captura) fuera del dominio.
 */
export interface UploadAndRegisterDocumentInput {
  /** `FleetDocumentType` canónico (p. ej. `LICENSE_A1` | `SOAT` | `PROPERTY_CARD`), no string libre. */
  type: FleetDocumentType;
  /** Archivo local capturado/elegido. */
  file: PickedImage;
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
    // 1) Sube el binario al almacén soberano (presign + PUT crudo). Propaga `DocumentUploadError`.
    const uploaded: UploadedDocumentBinary = await this.uploader.upload(input.type, input.file);

    // 2) Registra el documento CON la key real del binario subido. Solo se llega aquí si el PUT fue
    //    OK: jamás registramos un documento cuyo binario no se subió (honestidad de estado).
    return this.registrar.register({
      type: input.type,
      ...(input.metadata.documentNumber ? { documentNumber: input.metadata.documentNumber } : {}),
      ...(input.metadata.expiresAt ? { expiresAt: input.metadata.expiresAt } : {}),
      fileS3Key: uploaded.fileS3Key,
    });
  }
}
