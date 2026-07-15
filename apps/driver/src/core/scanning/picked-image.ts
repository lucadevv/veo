/**
 * Imagen seleccionada/capturada del dispositivo (cámara o galería). Vive en `core/` (capacidad
 * transversal de escaneo/imagen), NO en una feature, para que la compartan sin acoplarse entre sí:
 * el port de `documents` la re-exporta (contrato de subida de documentos), `profile` la usa para el
 * avatar y `registration` la reusa en su pipeline de escaneo. Es un tipo GENÉRICO (sin dependencias
 * de dominio de ninguna feature), por eso puede vivir en core sin invertir la dirección de deps.
 */

/** Imagen seleccionada por el conductor (galería o cámara). */
export interface PickedImage {
  /** URI local del archivo (`file://…` / `content://…`). */
  uri: string;
  /** MIME real (p. ej. `image/jpeg`); null si la plataforma no lo expone. */
  mimeType: string | null;
  /** Nombre de archivo si lo provee la plataforma. */
  fileName: string | null;
  width: number | null;
  height: number | null;
  /** Tamaño en bytes (útil para validar límites antes de subir). */
  fileSize: number | null;
}
