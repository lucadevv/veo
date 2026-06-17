import type { FaceCapture } from '../entities';

/**
 * Puerto de captura facial del REGISTRO (KYC del alta). Es propio del feature de registro y NO
 * comparte estado con la captura biométrica del inicio de turno (feature `shift`): el alta solo
 * necesita una referencia opaca para enviarla con el borrador.
 *
 * La captura por cámara + liveness es nativa. Aquí se define el contrato; la presentación construye
 * la guía circular y, al obtener el `ref`, lo guarda en el borrador.
 */
export interface FaceCaptureService {
  /** Ejecuta el flujo de captura para el alta: reto → frames → verify → referencia opaca. */
  captureForRegistration(): Promise<FaceCapture>;
}

/** Código del error cuando la captura nativa todavía no está instalada. */
export const FACE_CAPTURE_UNAVAILABLE = 'FACE_CAPTURE_UNAVAILABLE';

/** Error claro (no un mock) cuando el módulo de captura facial nativa aún no está disponible. */
export class FaceCaptureUnavailableError extends Error {
  readonly code = FACE_CAPTURE_UNAVAILABLE;
  constructor() {
    super('Captura facial nativa no instalada');
    this.name = 'FaceCaptureUnavailableError';
  }
}

/**
 * Implementación por defecto del puerto: lanza un error tipado (no devuelve datos falsos) hasta que
 * la presentación registre el proveedor real. Mantiene el typecheck verde y el contrato intacto.
 *
 * TODO(backend/nativo): sustituir por el proveedor real (frame-grabber AVFoundation/Camera2 +
 * verify contra el servicio KYC) cuando el módulo nativo y el endpoint estén disponibles.
 */
export class UnavailableFaceCaptureService implements FaceCaptureService {
  captureForRegistration(): Promise<FaceCapture> {
    return Promise.reject(new FaceCaptureUnavailableError());
  }
}
