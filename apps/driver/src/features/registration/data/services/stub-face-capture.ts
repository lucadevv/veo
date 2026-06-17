import type { FaceCapture, FaceCaptureService } from '../../domain';

/**
 * Implementación STUB del puerto de captura facial del registro (solo desarrollo).
 *
 * Devuelve una referencia OPACA generada localmente para que el flujo de KYC del alta sea
 * demostrable de extremo a extremo (KYC → "En revisión"). NO realiza verificación real ni accede a
 * la cámara: no comparte nada con la captura biométrica del inicio de turno (feature `shift`).
 *
 * TODO(nativo/backend): reemplazar por el proveedor real (frame-grabber AVFoundation/Camera2 +
 * verify contra el servicio KYC) que emita el `ref` real de la sesión de liveness/match.
 */
export class StubFaceCaptureService implements FaceCaptureService {
  async captureForRegistration(): Promise<FaceCapture> {
    await delay(900);
    return {
      // TODO(nativo): este `ref` es un marcador de desarrollo, no una sesión KYC real.
      ref: `dev-kyc-${Date.now()}`,
      score: 0.99,
      capturedAt: new Date().toISOString(),
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instancia compartida del stub (wiring local mientras no exista el módulo nativo/DI). */
export const stubFaceCaptureService = new StubFaceCaptureService();
