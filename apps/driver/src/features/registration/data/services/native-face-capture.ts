import {NativeModules, PermissionsAndroid, Platform, type Permission} from 'react-native';
import {
  FacePhotoGrabberUnavailableError,
  type FaceCapture,
  type FaceCaptureService,
  type FacePhotoGrabber,
} from '../../domain';

/**
 * Contrato del módulo nativo `VeoBiometricFrameGrabber` (iOS AVFoundation / Android Camera2). Es el
 * mismo módulo de cámara frontal que usa el gate biométrico del turno; aquí el alta solo necesita
 * `capturePhoto` (una foto JPEG base64). El alta no comparte estado con la captura del turno.
 */
interface NativeFrameGrabberModule {
  /** Captura una sola foto JPEG (base64, sin prefijo data URI) de la cámara frontal. */
  capturePhoto(): Promise<string>;
}

/** Acceso tipado al módulo nativo (undefined si no está enlazado en esta plataforma/build). */
const nativeModule = NativeModules.VeoBiometricFrameGrabber as NativeFrameGrabberModule | undefined;

/** Timeout (ms) para la captura de la foto: si la cámara no responde, abortamos con error claro. */
const PHOTO_TIMEOUT_MS = 12_000;

/**
 * Envuelve una promesa nativa con timeout. Sin esto, si la cámara nunca entrega un sample (cámara
 * ocupada, fallo de hardware, delegate de AVFoundation que no dispara), la promesa quedaría colgada
 * para siempre y la captura del alta se atascaría sin error. Con el timeout el flujo puede reintentar.
 */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new FacePhotoGrabberUnavailableError('La cámara no respondió a tiempo'));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * Implementación del grabber de foto facial sobre el módulo nativo de cámara. El nativo es el único
 * dueño de la cámara durante la captura (abre y libera la sesión por llamada). Si el módulo no está
 * enlazado o no produce imagen, lanza un error claro: nunca devuelve una foto vacía o simulada.
 */
export class NativeFacePhotoGrabber implements FacePhotoGrabber {
  async capturePhoto(): Promise<string> {
    if (!nativeModule) {
      throw new FacePhotoGrabberUnavailableError();
    }
    await ensureCameraPermission();
    const photo = await withTimeout(nativeModule.capturePhoto(), PHOTO_TIMEOUT_MS);
    if (!photo) {
      throw new FacePhotoGrabberUnavailableError('La captura de la foto no produjo imagen');
    }
    return photo;
  }
}

/**
 * Solicita el permiso de cámara en Android (en iOS lo gestiona AVFoundation vía Info.plist
 * `NSCameraUsageDescription`). Lanza un error claro si el conductor lo deniega: no se intenta
 * capturar sin permiso.
 */
async function ensureCameraPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.CAMERA as Permission,
  );
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new FacePhotoGrabberUnavailableError('Permiso de cámara denegado');
  }
}

/**
 * Implementación REAL del puerto de captura facial del registro. Captura una foto de rostro con la
 * cámara frontal (módulo nativo) y la entrega en el `FaceCapture` para enrolarla en
 * `POST /drivers/biometric/enroll`. La `ref` es una marca local opaca del alta (no hay endpoint de
 * sesión KYC/verify para el registro; el enrolamiento es lo que sube el asset facial real).
 */
export class NativeFaceCaptureService implements FaceCaptureService {
  constructor(private readonly grabber: FacePhotoGrabber) {}

  async captureForRegistration(): Promise<FaceCapture> {
    const photoBase64 = await this.grabber.capturePhoto();
    return {
      ref: `kyc-${Date.now()}`,
      score: 1,
      capturedAt: new Date().toISOString(),
      photoBase64,
    };
  }
}

/** Singleton del grabber nativo de foto facial para inyectar en la capa de presentación. */
export const nativeFacePhotoGrabber: FacePhotoGrabber = new NativeFacePhotoGrabber();

/** Singleton del servicio de captura facial REAL (grabber nativo). */
export const nativeFaceCaptureService: FaceCaptureService = new NativeFaceCaptureService(
  nativeFacePhotoGrabber,
);
