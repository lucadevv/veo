import { NativeModules, PermissionsAndroid, Platform, type Permission } from 'react-native';
import {
  LivenessFrameGrabberUnavailableError,
  type FrameCapturePlan,
  type FrameCaptureProgress,
  type LivenessFrameGrabber,
} from '../../domain';

/**
 * Contrato del módulo nativo `VeoBiometricFrameGrabber` (iOS AVFoundation / Android Camera2). Es el
 * MISMO módulo de cámara frontal que usa el gate biométrico del turno; aquí el alta solo necesita
 * `captureFrames` (la secuencia de frames del liveness). El alta no comparte estado con el turno.
 */
interface NativeFrameGrabberModule {
  /** Captura `frameCount` JPEG (base64, sin prefijo data URI) de la cámara frontal, con `intervalMs` entre frames. */
  captureFrames(frameCount: number, intervalMs: number): Promise<string[]>;
}

/** Acceso tipado al módulo nativo (undefined si no está enlazado en esta plataforma/build). */
const nativeModule = NativeModules.VeoBiometricFrameGrabber as NativeFrameGrabberModule | undefined;

/** Margen fijo (ms) que damos al nativo además del tiempo teórico de captura antes de abortar. */
const CAPTURE_TIMEOUT_BUFFER_MS = 8_000;

/**
 * Envuelve una promesa nativa con timeout. Sin esto, si la cámara nunca entrega un sample (cámara
 * ocupada, fallo de hardware, delegate de AVFoundation que no dispara), la promesa quedaría colgada
 * para siempre y la captura del alta se atascaría en `performing` sin error. Con el timeout el flujo
 * recibe un error tipado y la pantalla puede pedir un reto NUEVO y reintentar.
 */
function withCaptureTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new LivenessFrameGrabberUnavailableError(
          'La cámara no respondió a tiempo durante la captura de liveness',
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * Implementación del grabber de liveness sobre el módulo nativo de cámara. El nativo es el único dueño
 * de la cámara durante la captura (abre y libera la sesión por llamada), por lo que NO se usa
 * `getUserMedia` en paralelo. Si el módulo no está enlazado o no produce frames, lanza un error claro:
 * nunca devuelve frames vacíos o simulados (un vacío es un fallo de captura).
 *
 * El módulo nativo NO emite progreso intermedio (entrega el lote completo al resolver). Para que el
 * anillo de la pantalla avance de forma honesta sin fingir, reportamos progreso al INICIO (0) y al
 * COMPLETAR (1): no inventamos pasos intermedios que el nativo no nos da. Si en el futuro el módulo
 * expone un evento por-frame, se conecta aquí sin tocar el puerto.
 */
export class NativeLivenessFrameGrabber implements LivenessFrameGrabber {
  async captureFrames(plan: FrameCapturePlan, onProgress?: FrameCaptureProgress): Promise<string[]> {
    if (!nativeModule) {
      throw new LivenessFrameGrabberUnavailableError();
    }
    await ensureCameraPermission();
    onProgress?.(0);
    const expectedMs = plan.frameCount * plan.intervalMs + CAPTURE_TIMEOUT_BUFFER_MS;
    const frames = await withCaptureTimeout(
      nativeModule.captureFrames(plan.frameCount, plan.intervalMs),
      expectedMs,
    );
    if (!Array.isArray(frames) || frames.length === 0) {
      // El nativo siempre debe devolver frames reales; un vacío es un fallo de captura.
      throw new LivenessFrameGrabberUnavailableError(
        'La captura de frames de liveness no produjo imágenes',
      );
    }
    onProgress?.(1);
    return frames;
  }
}

/**
 * Solicita el permiso de cámara en Android (en iOS lo gestiona AVFoundation vía Info.plist
 * `NSCameraUsageDescription`). Lanza un error claro si el conductor lo deniega: no se captura sin permiso.
 */
async function ensureCameraPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.CAMERA as Permission,
  );
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new LivenessFrameGrabberUnavailableError('Permiso de cámara denegado');
  }
}

/** Singleton del grabber nativo de liveness para inyectar en la capa de presentación. */
export const nativeLivenessFrameGrabber: LivenessFrameGrabber = new NativeLivenessFrameGrabber();
