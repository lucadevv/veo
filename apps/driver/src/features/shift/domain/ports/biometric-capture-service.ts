import type {BiometricEnrollResult} from './biometric-backend';

/**
 * Puertos de captura biométrica (prueba de vida) del conductor.
 *
 * La captura por cámara y el liveness son NATIVOS (frame-grabber AVFoundation/Camera2). Aquí se
 * definen los contratos: la app construye la UI del flujo y, una vez obtenido el `sessionRef`, llama
 * `POST /drivers/shift/start` (regla #1 de CLAUDE.md: verificación obligatoria, lockout tras fallos).
 */

export interface BiometricCaptureResult {
  /** Referencia opaca de la sesión biométrica (liveness+match) emitida por el backend. */
  sessionRef: string;
  /** Score de match [0..1] (informativo para la UI). */
  score: number;
}

export interface BiometricCaptureService {
  /**
   * Ejecuta el flujo de inicio de turno: reto → captura de frames → verify → `sessionRef`.
   * Lanza errores de dominio tipados (no enrolado, rechazado, bloqueado, backend/cámara no disponible).
   */
  captureForShiftStart(): Promise<BiometricCaptureResult>;
}

export interface BiometricEnrollmentService {
  /** Captura una foto del rostro y la enrola en el backend (una sola vez). */
  enroll(): Promise<BiometricEnrollResult>;
}

/** Código del error cuando la captura nativa todavía no está instalada. */
export const BIOMETRIC_CAPTURE_UNAVAILABLE = 'BIOMETRIC_CAPTURE_UNAVAILABLE';

/** Error claro (no un mock) cuando el módulo de captura nativa aún no está disponible. */
export class BiometricCaptureUnavailableError extends Error {
  readonly code = BIOMETRIC_CAPTURE_UNAVAILABLE;
  constructor() {
    super('Captura biométrica nativa no instalada');
    this.name = 'BiometricCaptureUnavailableError';
  }
}

/**
 * Implementación por defecto de ambos puertos: lanza un error claro (no devuelve datos falsos) hasta
 * que la capa de presentación registre el servicio real. Mantiene el typecheck verde sin romper el
 * contrato (p. ej. en pruebas que montan el árbol sin proveedor real).
 */
export class UnavailableBiometricCaptureService
  implements BiometricCaptureService, BiometricEnrollmentService
{
  captureForShiftStart(): Promise<BiometricCaptureResult> {
    return Promise.reject(new BiometricCaptureUnavailableError());
  }
  enroll(): Promise<BiometricEnrollResult> {
    return Promise.reject(new BiometricCaptureUnavailableError());
  }
}
