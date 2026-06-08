/**
 * Puerto (DIP) para subir el avatar del usuario al almacenamiento de objetos (S3/MinIO) vía un
 * ticket prefirmado expedido por el BFF. La presentación y los casos de uso dependen de esta
 * ABSTRACCIÓN, nunca de la implementación concreta (cliente HTTP + fetch crudo a MinIO), de modo
 * que el flujo quede desacoplado y testeable (se puede inyectar un fake en tests). La
 * implementación vive en `data/` y se cablea por el contenedor de DI.
 */

import type { PickedImage } from './imagePickerService';

/** Motivo accionable por el que la subida del avatar falló (para feedback claro al usuario). */
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
   * El backend no pudo CONFIRMAR la subida (`/users/me/avatar/confirm`). El binario quedó en el
   * almacén pero la cuota no se validó / la URL pública no se selló: hay que reintentar.
   */
  | 'confirm'
  /**
   * No se pudo LEER el binario local del archivo elegido (p. ej. `content://`/`file://` ilegible o
   * `.blob()` no soportado). Distinto de `network`: el fallo es de acceso al archivo, no de red.
   */
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
   *  1. Deriva `contentType`/`ext` del archivo (lista blanca); si no casa, lanza
   *     `AvatarUploadError('unsupported-type')`.
   *  2. Pide un ticket prefirmado al BFF (incluye `maxBytes`).
   *  3. Lee el binario local; si excede `maxBytes`, lanza `AvatarUploadError('too-large')` SIN subir.
   *  4. Sube el binario crudo (PUT) directo al almacén de objetos.
   *  5. Confirma con el BFF (`/users/me/avatar/confirm`): el backend valida la cuota de tamaño
   *     (autoritativo; borra el objeto si excede) y devuelve la `publicUrl` sellada.
   * Lanza `AvatarUploadError` ante fallos accionables.
   */
  uploadAvatar(file: PickedImage): Promise<{ photoUrl: string }>;
}
