/**
 * Puerto (DIP) para seleccionar/capturar una imagen del dispositivo (cámara o galería). La
 * presentación y los casos de uso dependen de esta ABSTRACCIÓN, nunca del SDK nativo concreto
 * (`react-native-image-picker`), de modo que el flujo quede desacoplado y testeable (se puede
 * inyectar un fake en tests). La implementación REAL vive en `data/` y se cablea por el contenedor
 * de DI. Espeja el puerto homónimo de la app pasajero (mismo SDK), pero es PROPIO del driver para no
 * acoplar las dos apps.
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

/** Origen desde el que capturar la imagen. */
export type ImageSource = 'camera' | 'library';

/** Motivo accionable por el que no se obtuvo imagen (para feedback claro al conductor). */
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

/** Selección/captura de imagen nativa encapsulada tras una interfaz de dominio. */
export interface ImagePickerService {
  /**
   * Abre la fuente indicada (cámara o galería) y resuelve con la imagen elegida, o `null` si el
   * conductor canceló. Lanza `ImagePickError` ante fallos accionables (permiso denegado, cámara no
   * disponible). NUNCA devuelve datos simulados.
   */
  pick(source: ImageSource, options?: ImagePickOptions): Promise<PickedImage | null>;
}
