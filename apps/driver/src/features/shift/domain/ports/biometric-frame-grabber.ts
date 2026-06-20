/**
 * Puerto del frame-grabber biométrico: captura REAL de frames JPEG desde la cámara frontal del
 * dispositivo para la prueba de vida (liveness), tanto del inicio de turno como del re-enrolamiento
 * de rostro. Ambos flujos capturan una SECUENCIA de frames guiada por la acción del reto (no una foto
 * suelta: la foto única era spoofeable y el backend ya no la acepta).
 *
 * La extracción de píxeles no es posible desde un track de `react-native-webrtc` en JS, por lo que la
 * captura la realiza el módulo nativo `VeoBiometricFrameGrabber` (AVFoundation en iOS, Camera2 en
 * Android). Este puerto define el contrato; la implementación lo invoca y NO produce imágenes vacías.
 */

/** Plan de captura derivado del reto del servidor (cuántos frames y a qué cadencia). */
export interface FrameCapturePlan {
  /** Número de frames JPEG a capturar durante la acción de liveness. */
  frameCount: number;
  /** Intervalo entre frames en milisegundos. */
  intervalMs: number;
  /** Acción del reto (informativa para el nativo y para guiar al conductor). */
  action: string;
}

export interface BiometricFrameGrabber {
  /**
   * Captura una secuencia temporal de frames JPEG (base64, sin encabezado data URI) siguiendo el
   * plan derivado del reto. Abre y libera la cámara frontal.
   */
  captureSequence(plan: FrameCapturePlan): Promise<string[]>;
}

/** Cantidad de frames por acción de liveness (defaults sensatos; el servidor valida el resultado). */
const FRAME_COUNT_BY_ACTION: Record<string, number> = {
  BLINK: 12,
  SMILE: 8,
  NOD: 12,
  TURN_LEFT: 10,
  TURN_RIGHT: 10,
};

/** Frames por defecto cuando la acción no está mapeada (cubre acciones nuevas del backend). */
const DEFAULT_FRAME_COUNT = 10;
/** Cadencia por defecto entre frames (≈10 fps): suficiente para liveness sin saturar el upload. */
const DEFAULT_INTERVAL_MS = 100;

/**
 * Deriva el plan de captura a partir de la acción del reto. Es lógica pura y testeable: no toca la
 * cámara ni el backend. Acciones más dinámicas (parpadeo/asentir) capturan más frames.
 */
export function planForChallenge(action: string): FrameCapturePlan {
  const normalized = action.trim().toUpperCase();
  const frameCount = FRAME_COUNT_BY_ACTION[normalized] ?? DEFAULT_FRAME_COUNT;
  return { frameCount, intervalMs: DEFAULT_INTERVAL_MS, action };
}

/** Código de error cuando el módulo nativo de captura no está enlazado. */
export const BIOMETRIC_FRAME_GRABBER_UNAVAILABLE = 'BIOMETRIC_FRAME_GRABBER_UNAVAILABLE';

/** Error claro cuando el frame-grabber nativo no está disponible (no se devuelven datos falsos). */
export class BiometricFrameGrabberUnavailableError extends Error {
  readonly code = BIOMETRIC_FRAME_GRABBER_UNAVAILABLE;
  constructor(message = 'El módulo nativo de captura biométrica no está disponible') {
    super(message);
    this.name = 'BiometricFrameGrabberUnavailableError';
  }
}
