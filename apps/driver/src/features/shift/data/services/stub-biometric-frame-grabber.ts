import type {
  BiometricFrameGrabber,
  FrameCapturePlan,
} from '../../domain/ports/biometric-frame-grabber';

/**
 * Frame-grabber STUB — SOLO desarrollo en simulador (sin cámara). Devuelve frames JPEG sintéticos en
 * vez de capturar de la cámara frontal, para poder ejercer el gate biométrico de inicio de turno y el
 * enrolamiento en el simulador.
 *
 * Por qué es seguro / honesto:
 *  - NO es un mock del flujo: se sigue usando el `LivenessBiometricCaptureService` REAL y el backend
 *    REAL (challenge → verify → sessionRef). Lo único sintético son los píxeles.
 *  - El backend en modo `VEO_BIOMETRIC_MODE=sandbox` (dev/CI, ver identity-service `biometric.module`)
 *    IGNORA el contenido de los frames: solo verifica el `challengeId` (falla si contiene 'fail') y
 *    devuelve score 96 + liveness/match OK. Con `live` (device + ONNX) este stub NO pasaría — y no
 *    debe usarse: la composición solo lo inyecta cuando el módulo nativo no está enlazado Y `__DEV__`.
 *  - Nunca llega a producción: la selección está gateada por `__DEV__` (los bundles de release lo
 *    eliminan) en `RealBiometricCaptureProvider`.
 */

/**
 * JPEG mínimo válido (1×1) en base64, sin encabezado data URI — mismo formato que entrega el grabber
 * nativo. El sandbox no inspecciona el contenido; usamos un JPEG real para respetar el contrato.
 */
const SYNTHETIC_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

/** Pausa breve para simular la cadencia de captura (que el feedback "capturando…" se sienta real). */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Tope de la espera simulada (ms): suficiente para sentirse real sin demorar el flujo dev. */
const MAX_SIMULATED_CAPTURE_MS = 1200;

export class StubBiometricFrameGrabber implements BiometricFrameGrabber {
  async captureSequence(plan: FrameCapturePlan): Promise<string[]> {
    await delay(Math.min(plan.frameCount * plan.intervalMs, MAX_SIMULATED_CAPTURE_MS));
    return Array.from({length: plan.frameCount}, () => SYNTHETIC_JPEG_BASE64);
  }

  async capturePhoto(): Promise<string> {
    await delay(400);
    return SYNTHETIC_JPEG_BASE64;
  }
}

/** Singleton del frame-grabber stub para la composición dev (simulador). */
export const stubBiometricFrameGrabber: BiometricFrameGrabber = new StubBiometricFrameGrabber();
