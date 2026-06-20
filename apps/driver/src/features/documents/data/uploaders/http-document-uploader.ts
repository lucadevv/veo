import {
  type DocumentUploadContentType,
  type DocumentUploadSideTicket,
  documentUploadTicket,
  type HttpClient,
} from '@veo/api-client';
import type { FleetDocumentType } from '@veo/shared-types';
import {
  type DocumentSideFile,
  DocumentUploadError,
  type DocumentUploader,
  type UploadedDocumentBinary,
  type UploadedDocumentImage,
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

  async upload(
    type: FleetDocumentType,
    sides: DocumentSideFile[],
  ): Promise<UploadedDocumentBinary> {
    // 0) Sin caras no hay nada que subir: el caso de uso siempre pasa ≥1 (defensa de borde igualmente).
    const [firstSide] = sides;
    if (!firstSide) {
      throw new DocumentUploadError('read', 'No se entregó ninguna imagen para subir');
    }

    // 0-bis) Deriva el contentType de CADA archivo (allowlist del contrato); si alguno no casa, falla
    //    pronto. El presign del contrato lleva UN `contentType` por documento (todas las caras comparten
    //    formato: el escáner siempre entrega JPEG), así que usamos el de la primera cara para el ticket.
    const contentType = this.resolveContentType(firstSide.file);
    for (const { file } of sides) {
      this.resolveContentType(file);
    }

    // 1) Tickets prefirmados (uno POR CARA): ESTA llamada va por el cliente autenticado del BFF (Bearer).
    //    Enviamos las `sides` pedidas; el BFF devuelve un ticket por cara (`tickets[]`).
    const requestedSides = sides.map(({ side }) => side);
    let ticket: ReturnType<typeof documentUploadTicket.parse>;
    try {
      ticket = await this.http.post(DOCUMENTS_PRESIGN_PATH, {
        body: { type, contentType, sides: requestedSides },
        schema: documentUploadTicket,
      });
    } catch (error) {
      throw new DocumentUploadError('presign', (error as Error).message);
    }

    // 2) Sube cada cara emparejando el ticket con su archivo POR `side` (no por orden: el BFF podría
    //    reordenar). Si falta un ticket para una cara pedida, es un fallo de presign (no inventamos).
    const images: UploadedDocumentImage[] = [];
    for (const { side, file } of sides) {
      const sideTicket = ticket.tickets.find((candidate) => candidate.side === side);
      if (!sideTicket) {
        throw new DocumentUploadError(
          'presign',
          `El presign no devolvió un ticket para la cara ${side}`,
        );
      }
      const s3Key = await this.putSide(sideTicket, file);
      images.push({ s3Key, side });
    }

    // 3) Devuelve las keys subidas por cara: el caso de uso las reenvía como `images` al registrar.
    return { images };
  }

  /**
   * Sube el binario de UNA cara con el ticket prefirmado correspondiente y devuelve su `fileS3Key`.
   *  - Lee el binario local como blob (fallo de acceso → `read`, distinto de un fallo de red).
   *  - PUT de bytes crudos DIRECTO al almacén soberano con los `requiredHeaders` firmados del ticket
   *    (incluye el `Content-Type` firmado en la URL); el `Authorization` del BFF NO se incluye (el
   *    `fetchImpl` crudo no lo inyecta).
   */
  private async putSide(ticket: DocumentUploadSideTicket, file: PickedImage): Promise<string> {
    // La URI puede ser `file://…` (iOS/Android), `content://…` (Android SAF) o `data:…` (escáner).
    const blob = await this.readLocalBlob(file.uri);

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

    return ticket.fileS3Key;
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
