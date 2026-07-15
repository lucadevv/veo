/**
 * Puerto (DIP) para subir la FOTO DE PERFIL (avatar) del conductor al almacenamiento de objetos
 * (S3/MinIO soberano) vía un ticket prefirmado expedido por el driver-bff. La presentación y los casos
 * de uso dependen de esta ABSTRACCIÓN, nunca de la implementación concreta (cliente HTTP + fetch crudo a
 * MinIO), de modo que el flujo quede desacoplado y testeable. La implementación vive en `data/` y se
 * cablea por el contenedor de DI. Espeja el `AvatarUploader` de la app pasajero (mismo contrato de media),
 * pero el confirm del driver-bff ADEMÁS persiste la foto en el perfil (no hace falta un PATCH aparte).
 */

import type { PickedImage } from '../../../documents/domain/ports/image-picker-service';

/** Motivo accionable por el que la subida del avatar falló (para feedback claro al conductor). */
export type AvatarUploadFailure =
  /** El formato/MIME de la imagen no está en la lista blanca (jpg/jpeg/png/webp). */
  | 'unsupported-type'
  /** El BFF no pudo expedir el ticket de subida prefirmado. */
  | 'presign'
  /** El almacén de objetos (S3/MinIO) rechazó el binario (status != 2xx). */
  | 'upload'
  /**
   * La imagen excede la cuota de tamaño (`ticket.maxBytes`). Se detecta en cliente ANTES del PUT
   * (fail-fast) y/o la rechaza el backend en el `confirm` (autoritativo: borra el objeto y responde 400).
   */
  | 'too-large'
  /**
   * El backend no pudo CONFIRMAR la subida (`/drivers/me/avatar/confirm`). El binario quedó en el
   * almacén pero la cuota no se validó / la foto no se persistió: hay que reintentar.
   */
  | 'confirm'
  /** No se pudo LEER el binario local del archivo elegido (URI ilegible o `.blob()` no soportado). */
  | 'read'
  /** Fallo de red al subir el binario (PUT al almacén de objetos). */
  | 'network';

/** Error de subida del avatar con un motivo accionable. */
export class AvatarUploadError extends Error {
  constructor(
    readonly reason: AvatarUploadFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'AvatarUploadError';
  }
}

/** Subida del avatar encapsulada tras una interfaz de dominio. */
export interface AvatarUploader {
  /**
   * Sube la imagen local elegida y resuelve con la `photoUrl` pública resultante. El flujo:
   *  1. Deriva `contentType`/`ext` del archivo (lista blanca); si no casa, lanza `unsupported-type`.
   *  2. Pide un ticket prefirmado al BFF (incluye `maxBytes`).
   *  3. Lee el binario local; si excede `maxBytes`, lanza `too-large` SIN subir.
   *  4. Sube el binario crudo (PUT) directo al almacén de objetos.
   *  5. Confirma con el BFF (`/drivers/me/avatar/confirm`): el backend valida la cuota (autoritativo) y
   *     persiste la foto en el perfil del conductor, devolviendo la `publicUrl` sellada.
   * Lanza `AvatarUploadError` ante fallos accionables.
   */
  uploadAvatar(file: PickedImage): Promise<{ photoUrl: string }>;
}
