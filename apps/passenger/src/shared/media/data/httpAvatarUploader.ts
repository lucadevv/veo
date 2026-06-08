import {
  type AvatarUploadRequest,
  avatarUploadConfirmed,
  avatarUploadTicket,
  type HttpClient,
} from '@veo/api-client';
import { AvatarUploadError, type AvatarUploader } from '../domain/avatarUploader';
import type { PickedImage } from '../domain/imagePickerService';

/** Endpoint del ticket prefirmado (el BFF ya tiene el guard de pasajero por el JWT global). */
const AVATAR_PRESIGN_PATH = '/users/me/avatar/presign';
/** Endpoint de confirmación: el backend valida la cuota de tamaño y sella la `publicUrl`. */
const AVATAR_CONFIRM_PATH = '/users/me/avatar/confirm';

/** Descriptor del avatar derivado del archivo elegido (coherente con el contrato del BFF). */
type AvatarDescriptor = AvatarUploadRequest;

/** Lista blanca por MIME real del picker → (contentType canónico, extensión). */
const MIME_MAP: Record<string, AvatarDescriptor> = {
  'image/jpeg': { contentType: 'image/jpeg', ext: 'jpg' },
  'image/jpg': { contentType: 'image/jpeg', ext: 'jpg' },
  'image/png': { contentType: 'image/png', ext: 'png' },
  'image/webp': { contentType: 'image/webp', ext: 'webp' },
};

/** Lista blanca por extensión de archivo → (contentType canónico, extensión). */
const EXTENSION_MAP: Record<string, AvatarDescriptor> = {
  jpg: { contentType: 'image/jpeg', ext: 'jpg' },
  jpeg: { contentType: 'image/jpeg', ext: 'jpeg' },
  png: { contentType: 'image/png', ext: 'png' },
  webp: { contentType: 'image/webp', ext: 'webp' },
};

/**
 * Implementación de `AvatarUploader` con subida prefirmada a S3/MinIO.
 *
 * Reparto de responsabilidades respetando que la PUT NO pasa por el cliente autenticado del BFF:
 *  - El `HttpClient` (Bearer del BFF) SOLO se usa para pedir el ticket en `/users/me/avatar/presign`.
 *  - La lectura del binario local y el PUT van por `fetch` crudo directo a MinIO (sin Authorization),
 *    inyectable para poder mockearlo en tests.
 */
export class HttpAvatarUploader implements AvatarUploader {
  constructor(
    private readonly http: HttpClient,
    /** `fetch` para leer el archivo local y subir el binario (inyectable en tests). */
    private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async uploadAvatar(file: PickedImage): Promise<{ photoUrl: string }> {
    const descriptor = this.resolveDescriptor(file);

    // 1) Ticket prefirmado: ESTA llamada va por el cliente autenticado del BFF.
    let ticket: ReturnType<typeof avatarUploadTicket.parse>;
    try {
      ticket = await this.http.post(AVATAR_PRESIGN_PATH, {
        body: descriptor,
        schema: avatarUploadTicket,
      });
    } catch (error) {
      throw new AvatarUploadError('presign', (error as Error).message);
    }

    // 2) Lee el binario local como blob. La URI puede ser `file://…` (iOS/Android) o `content://…`
    //    (Android Storage Access Framework). `fetch(uri).blob()` sobre `content://` es frágil en
    //    Android, así que separamos las dos etapas para distinguir un fallo de ACCESO al archivo
    //    (`read`) de un fallo de red, y degradamos con un error claro cuando `blob()` no aplica.
    const blob = await this.readLocalBlob(file.uri);

    // 2.5) Cuota de tamaño en CLIENTE (fail-fast): el presign PUT no puede acotar el Content-Length,
    //       así que evitamos un PUT inútil de un archivo demasiado grande. El backend la revalida en
    //       el `confirm` (autoritativo); este chequeo es solo UX para un mensaje inmediato y claro.
    if (blob.size > ticket.maxBytes) {
      throw new AvatarUploadError(
        'too-large',
        `La imagen pesa ${blob.size} bytes y el máximo es ${ticket.maxBytes}`,
      );
    }

    // 3) PUT de bytes crudos DIRECTO a MinIO (sin Authorization del BFF; usa los headers del ticket).
    let uploadResponse: Response;
    try {
      uploadResponse = await this.fetchImpl(ticket.uploadUrl, {
        method: ticket.method,
        headers: ticket.headers,
        body: blob,
      });
    } catch (error) {
      throw new AvatarUploadError('network', (error as Error).message);
    }
    if (!uploadResponse.ok) {
      throw new AvatarUploadError(
        'upload',
        `El almacén de objetos respondió ${uploadResponse.status}`,
      );
    }

    // 4) Confirma con el BFF: media-service valida la cuota REAL del objeto subido (autoritativo) y,
    //    si excede, borra el objeto y responde 400. Devuelve la `publicUrl` sellada (NO usamos la del
    //    ticket: solo tras una confirmación válida la foto es legítima). Esta llamada SÍ va por el
    //    cliente autenticado del BFF.
    try {
      const confirmed = await this.http.post(AVATAR_CONFIRM_PATH, {
        body: { key: ticket.key },
        schema: avatarUploadConfirmed,
      });
      return { photoUrl: confirmed.publicUrl };
    } catch (error) {
      throw new AvatarUploadError('confirm', (error as Error).message);
    }
  }

  /**
   * Lee el binario local de la URI elegida como `Blob`, robusto en iOS y Android.
   *
   * Etapas separadas para dar un motivo accionable:
   *  - `fetch(uri)` falla (no se pudo abrir el recurso `file://`/`content://`) → `read`.
   *  - la respuesta no soporta `.blob()` (algunos polyfills/RN sobre `content://`) → `read`.
   *  - `.blob()` lanza al materializar los bytes (archivo ilegible/permiso) → `read`.
   *  - el blob viene vacío (0 bytes) → `read` (subir 0 bytes rompería el avatar).
   * Un fallo de red real solo puede ocurrir aquí si la URI fuese remota; el caso normal (local) se
   * clasifica como `read` para no confundir al usuario con un "problema de conexión".
   */
  private async readLocalBlob(uri: string): Promise<Blob> {
    let localResponse: Response;
    try {
      localResponse = await this.fetchImpl(uri);
    } catch (error) {
      // No se pudo abrir el recurso local (típico en Android con `content://` no resoluble).
      throw new AvatarUploadError('read', this.describeReadError(uri, error));
    }

    if (typeof localResponse.blob !== 'function') {
      throw new AvatarUploadError(
        'read',
        `La respuesta local de ${uri} no soporta blob() (content:// no legible)`,
      );
    }

    let blob: Blob;
    try {
      blob = await localResponse.blob();
    } catch (error) {
      throw new AvatarUploadError('read', this.describeReadError(uri, error));
    }

    if (!blob || blob.size === 0) {
      throw new AvatarUploadError('read', `El archivo local ${uri} está vacío o es ilegible`);
    }

    return blob;
  }

  /** Mensaje legible para fallos de lectura local (incluye la URI y la causa subyacente). */
  private describeReadError(uri: string, error: unknown): string {
    const cause = error instanceof Error ? error.message : String(error);
    return `No se pudo leer el archivo local ${uri}: ${cause}`;
  }

  /** Deriva el descriptor (contentType/ext) del archivo; prioriza el MIME y cae a la extensión. */
  private resolveDescriptor(file: PickedImage): AvatarDescriptor {
    const byMime = file.mimeType ? MIME_MAP[file.mimeType.toLowerCase()] : undefined;
    if (byMime) {
      return byMime;
    }
    const extension = this.extractExtension(file.fileName) ?? this.extractExtension(file.uri);
    const byExtension = extension ? EXTENSION_MAP[extension] : undefined;
    if (byExtension) {
      return byExtension;
    }
    throw new AvatarUploadError(
      'unsupported-type',
      `Formato de imagen no soportado: ${file.mimeType ?? extension ?? 'desconocido'}`,
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
