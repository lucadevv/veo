/**
 * Puerto (DIP) para seleccionar una imagen del dispositivo. La presentación depende de esta
 * ABSTRACCIÓN, nunca del SDK nativo concreto (`react-native-image-picker`), de modo que la lógica
 * de UI quede desacoplada y testeable (se puede inyectar un fake en tests). La implementación vive
 * en `data/` y se cablea por el contenedor de DI.
 */

/** Imagen seleccionada por el usuario (galería o cámara). */
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

/** Origen desde el que capturar la imagen. */
export type ImageSource = 'camera' | 'library';

/** Motivo accionable por el que no se obtuvo imagen (para feedback claro al usuario). */
export type ImagePickFailure = 'permission' | 'unavailable' | 'unknown';

/** Error de selección de imagen con un motivo accionable (cancelar NO es error: devuelve `null`). */
export class ImagePickError extends Error {
  constructor(
    readonly reason: ImagePickFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'ImagePickError';
  }
}

/** Opciones de redimensionado/compresión (la implementación aplica defaults sensatos). */
export interface ImagePickOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Calidad de compresión 0–1. */
  quality?: number;
}

/** Selección de imagen nativa encapsulada tras una interfaz de dominio. */
export interface ImagePickerService {
  /**
   * Abre la fuente indicada y resuelve con la imagen elegida, o `null` si el usuario canceló.
   * Lanza `ImagePickError` ante fallos accionables (permiso denegado, cámara no disponible).
   */
  pick(source: ImageSource, options?: ImagePickOptions): Promise<PickedImage | null>;
}
