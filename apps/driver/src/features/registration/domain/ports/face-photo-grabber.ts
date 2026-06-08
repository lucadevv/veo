/**
 * Puerto de captura de UNA foto de rostro desde la cámara frontal (KYC del alta). Es propio del
 * feature de registro (SOLID-I): solo expone lo que el alta necesita (una foto JPEG base64), sin
 * acoplarse al frame-grabber de liveness del turno. La implementación concreta vive en `data/`
 * (módulo nativo de cámara) y se inyecta por DI/provider (SOLID-D).
 */
export interface FacePhotoGrabber {
  /** Abre la cámara frontal, captura una foto y la devuelve en base64 (JPEG, sin prefijo data URI). */
  capturePhoto(): Promise<string>;
}

/** Código del error cuando el módulo nativo de cámara no está disponible o falla la captura. */
export const FACE_PHOTO_GRABBER_UNAVAILABLE = 'FACE_PHOTO_GRABBER_UNAVAILABLE';

/** Error claro (no datos falsos) cuando el módulo de cámara no está enlazado o no captura. */
export class FacePhotoGrabberUnavailableError extends Error {
  readonly code = FACE_PHOTO_GRABBER_UNAVAILABLE;
  constructor(message = 'El módulo nativo de cámara no está disponible') {
    super(message);
    this.name = 'FacePhotoGrabberUnavailableError';
  }
}
