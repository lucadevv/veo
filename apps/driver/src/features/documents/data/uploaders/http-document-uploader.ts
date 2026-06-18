import {
  type DocumentUploadContentType,
  documentUploadTicket,
  type HttpClient,
} from '@veo/api-client';
import type { FleetDocumentType } from '@veo/shared-types';
import {
  DocumentUploadError,
  type DocumentUploader,
  type UploadedDocumentBinary,
} from '../../domain/ports/document-uploader';
import type { PickedImage } from '../../domain/ports/image-picker-service';

/** Endpoint del ticket prefirmado de subida de documentos (el BFF resuelve el driver por el JWT). */
const DOCUMENTS_PRESIGN_PATH = '/drivers/me/documents/presign';

/** Lista blanca por MIME real del picker → `contentType` canónico del contrato (jpeg/png/pdf). */
const MIME_MAP: Record<string, DocumentUploadContentType> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'application/pdf': 'application/pdf',
};

/** Lista blanca por extensión de archivo → `contentType` canónico del contrato. */
const EXTENSION_MAP: Record<string, DocumentUploadContentType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
};

/**
 * Implementación de `DocumentUploader` con subida prefirmada al almacén soberano (S3/MinIO).
 *
 * Reparto de responsabilidades respetando que el PUT NO pasa por el cliente autenticado del BFF
 * (Ley 29733: el binario es PII y va directo al almacén, fuera de la API):
 *  - El `HttpClient` (Bearer del BFF) SOLO se usa para pedir el ticket en `/drivers/me/documents/presign`.
 *  - La lectura del binario local y el PUT van por `fetch` CRUDO directo al almacén (sin Authorization
 *    del BFF: solo los `requiredHeaders` firmados del ticket), inyectable para mockearlo en tests.
 *
 * Sigue el patrón del `HttpAvatarUploader` del pasajero, pero el flujo del documento es presign →
 * PUT (el `register` con el `fileS3Key` lo encadena el caso de uso, no este uploader).
 */
export class HttpDocumentUploader implements DocumentUploader {
  constructor(
    private readonly http: HttpClient,
    /** `fetch` para leer el archivo local y subir el binario (inyectable en tests). */
    private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async upload(type: FleetDocumentType, file: PickedImage): Promise<UploadedDocumentBinary> {
    // 0) Deriva el contentType del archivo (allowlist del contrato); si no casa, falla pronto.
    const contentType = this.resolveContentType(file);

    // 1) Ticket prefirmado: ESTA llamada va por el cliente autenticado del BFF (Bearer).
    let ticket: ReturnType<typeof documentUploadTicket.parse>;
    try {
      ticket = await this.http.post(DOCUMENTS_PRESIGN_PATH, {
        body: { type, contentType },
        schema: documentUploadTicket,
      });
    } catch (error) {
      throw new DocumentUploadError('presign', (error as Error).message);
    }

    // 2) Lee el binario local como blob. La URI puede ser `file://…` (iOS/Android) o `content://…`
    //    (Android Storage Access Framework). Separamos lectura de red para distinguir un fallo de
    //    ACCESO al archivo (`read`) de un fallo de red.
    const blob = await this.readLocalBlob(file.uri);

    // 3) PUT de bytes crudos DIRECTO al almacén soberano. Reenvía EXACTOS los `requiredHeaders`
    //    firmados del ticket (incluye el `Content-Type` que viajó firmado en la URL prefirmada); el
    //    `Authorization` del BFF NO se incluye (el `fetchImpl` crudo no lo inyecta).
    let uploadResponse: Response;
    try {
      uploadResponse = await this.fetchImpl(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.requiredHeaders,
        body: blob,
      });
    } catch (error) {
      throw new DocumentUploadError('network', (error as Error).message);
    }
    if (!uploadResponse.ok) {
      throw new DocumentUploadError(
        'upload',
        `El almacén de objetos respondió ${uploadResponse.status}`,
      );
    }

    // 4) Devuelve la key del objeto subido: el caso de uso la reenvía como `fileS3Key` al registrar.
    return { fileS3Key: ticket.fileS3Key };
  }

  /**
   * Lee el binario local de la URI elegida como `Blob`, robusto en iOS y Android. Etapas separadas
   * para dar un motivo accionable; cualquier fallo de acceso local se clasifica como `read` (no
   * `network`) para no confundir al conductor con un "problema de conexión".
   */
  private async readLocalBlob(uri: string): Promise<Blob> {
    let localResponse: Response;
    try {
      localResponse = await this.fetchImpl(uri);
    } catch (error) {
      throw new DocumentUploadError('read', this.describeReadError(uri, error));
    }

    if (typeof localResponse.blob !== 'function') {
      throw new DocumentUploadError(
        'read',
        `La respuesta local de ${uri} no soporta blob() (content:// no legible)`,
      );
    }

    let blob: Blob;
    try {
      blob = await localResponse.blob();
    } catch (error) {
      throw new DocumentUploadError('read', this.describeReadError(uri, error));
    }

    if (!blob || blob.size === 0) {
      throw new DocumentUploadError('read', `El archivo local ${uri} está vacío o es ilegible`);
    }

    return blob;
  }

  /** Mensaje legible para fallos de lectura local (incluye la URI y la causa subyacente). */
  private describeReadError(uri: string, error: unknown): string {
    const cause = error instanceof Error ? error.message : String(error);
    return `No se pudo leer el archivo local ${uri}: ${cause}`;
  }

  /** Deriva el `contentType` del archivo; prioriza el MIME real y cae a la extensión. */
  private resolveContentType(file: PickedImage): DocumentUploadContentType {
    const byMime = file.mimeType ? MIME_MAP[file.mimeType.toLowerCase()] : undefined;
    if (byMime) {
      return byMime;
    }
    const extension =
      this.extractExtension(file.fileName) ?? this.extractExtension(file.uri);
    const byExtension = extension ? EXTENSION_MAP[extension] : undefined;
    if (byExtension) {
      return byExtension;
    }
    throw new DocumentUploadError(
      'unsupported-type',
      `Formato de documento no soportado: ${file.mimeType ?? extension ?? 'desconocido'}`,
    );
  }

  /** Extrae la extensión en minúsculas de un nombre/URI (ignora query strings). */
  private extractExtension(value: string | null): string | null {
    if (!value) {
      return null;
    }
    const match = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(value);
    const extension = match?.[1];
    return extension ? extension.toLowerCase() : null;
  }
}
