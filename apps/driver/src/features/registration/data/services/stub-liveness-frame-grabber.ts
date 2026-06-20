import type { FrameCapturePlan, FrameCaptureProgress, LivenessFrameGrabber } from '../../domain';

/**
 * Implementación STUB del grabber de liveness del registro (solo desarrollo/pruebas y fallback).
 *
 * NO accede a la cámara: simula la captura entregando `plan.frameCount` frames marcadores y reportando
 * progreso real de 0..1 a medida que "avanza", para que el flujo de KYC del alta (reto → ejecutar gesto
 * → captura → enrolar) quede demostrable de extremo a extremo sin módulo nativo. Los frames son
 * placeholders base64 plausibles (no imágenes reales): el stub no comparte nada con la captura del turno.
 *
 * TODO(nativo): reemplazar por `nativeLivenessFrameGrabber` (cámara real) en producción.
 */
export class StubLivenessFrameGrabber implements LivenessFrameGrabber {
  async captureFrames(plan: FrameCapturePlan, onProgress?: FrameCaptureProgress): Promise<string[]> {
    onProgress?.(0);
    const frames: string[] = [];
    for (let i = 0; i < plan.frameCount; i += 1) {
      await delay(plan.intervalMs);
      frames.push(`dev-frame-${i}`);
      onProgress?.((i + 1) / plan.frameCount);
    }
    return frames;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instancia compartida del grabber stub (doble de pruebas / fallback local). */
export const stubLivenessFrameGrabber: LivenessFrameGrabber = new StubLivenessFrameGrabber();
