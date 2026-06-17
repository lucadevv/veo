import { NativeModules, PermissionsAndroid, Platform, type Permission } from 'react-native';
import {
  BiometricFrameGrabberUnavailableError,
  type BiometricFrameGrabber,
  type FrameCapturePlan,
} from '../../domain/ports/biometric-frame-grabber';

/** Contrato del módulo nativo `VeoBiometricFrameGrabber` (iOS AVFoundation / Android Camera2). */
interface NativeFrameGrabberModule {
  /** Captura `frameCount` JPEG (base64) de la cámara frontal con `intervalMs` entre frames. */
  captureFrames(frameCount: number, intervalMs: number): Promise<string[]>;
  /** Captura una sola foto JPEG (base64) de la cámara frontal (enrolamiento). */
  capturePhoto(): Promise<string>;
}

/** Acceso tipado al módulo nativo (undefined si no está enlazado en esta plataforma/build). */
const nativeModule = NativeModules.VeoBiometricFrameGrabber as NativeFrameGrabberModule | undefined;

/** Margen fijo (ms) que damos al nativo además del tiempo teórico de captura antes de abortar. */
const CAPTURE_TIMEOUT_BUFFER_MS = 8_000;
/** Timeout (ms) para la captura de una sola foto (enrolamiento). */
const PHOTO_TIMEOUT_MS = 12_000;

/**
 * Envuelve una promesa nativa con un timeout. Sin esto, si la cámara nunca entrega un sample (cámara
 * ocupada, fallo de hardware, delegate de AVFoundation que no dispara), la promesa quedaría colgada
 * para siempre y el inicio de turno se atascaría en fase `capturing` sin error. Con el timeout, el
 * flujo recibe un `BiometricFrameGrabberUnavailableError` y puede reintentar o mostrar el banner.
 */
function withCaptureTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new BiometricFrameGrabberUnavailableError(
          'La cámara no respondió a tiempo durante la captura biométrica',
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
 * Implementación del frame-grabber sobre el módulo nativo de cámara.
 *
 * El módulo nativo es el único dueño de la cámara durante la captura biométrica (abre y libera la
 * sesión por llamada), por lo que NO se usa `getUserMedia` en paralelo. Si el módulo no está enlazado
 * lanza un error claro: no se devuelven frames vacíos.
 */
export class NativeBiometricFrameGrabber implements BiometricFrameGrabber {
  async captureSequence(plan: FrameCapturePlan): Promise<string[]> {
    if (!nativeModule) {
      throw new BiometricFrameGrabberUnavailableError();
    }
    await ensureCameraPermission();
    const expectedMs = plan.frameCount * plan.intervalMs + CAPTURE_TIMEOUT_BUFFER_MS;
    const frames = await withCaptureTimeout(
      nativeModule.captureFrames(plan.frameCount, plan.intervalMs),
      expectedMs,
    );
    if (!Array.isArray(frames) || frames.length === 0) {
      // El nativo siempre debe devolver frames reales; un vacío es un fallo de captura.
      throw new BiometricFrameGrabberUnavailableError(
        'La captura de frames de liveness no produjo imágenes',
      );
    }
    return frames;
  }

  async capturePhoto(): Promise<string> {
    if (!nativeModule) {
      throw new BiometricFrameGrabberUnavailableError();
    }
    await ensureCameraPermission();
    const photo = await withCaptureTimeout(nativeModule.capturePhoto(), PHOTO_TIMEOUT_MS);
    if (!photo) {
      throw new BiometricFrameGrabberUnavailableError('La captura de la foto no produjo imagen');
    }
    return photo;
  }
}

/**
 * Solicita el permiso de cámara en Android (en iOS lo gestiona AVFoundation vía Info.plist). Lanza un
 * error claro si el conductor lo deniega: no se intenta capturar sin permiso.
 */
async function ensureCameraPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.CAMERA as Permission,
  );
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new BiometricFrameGrabberUnavailableError('Permiso de cámara denegado');
  }
}

/** Singleton del frame-grabber nativo para inyectar en la capa de presentación. */
export const nativeBiometricFrameGrabber: BiometricFrameGrabber = new NativeBiometricFrameGrabber();

/**
 * `true` si el módulo nativo de cámara está enlazado en este build/plataforma. Es `false` en el
 * SIMULADOR (no hay `VeoBiometricFrameGrabber`). La composición lo usa para, SOLO en dev, caer a un
 * grabber stub y poder probar el gate biométrico de turno sin cámara real. Nunca altera producción.
 */
export const nativeBiometricFrameGrabberLinked: boolean = nativeModule !== undefined;
