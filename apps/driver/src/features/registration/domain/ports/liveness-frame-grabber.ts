import { LivenessAction } from '@veo/shared-types';

/**
 * Puerto de captura de LIVENESS REACTIVO del REGISTRO (KYC del alta). Es propio del feature de
 * registro (SOLID-I) y NO comparte estado con la captura biométrica del inicio de turno (feature
 * `shift`): aunque el flujo es análogo (reto → frames → enroll), el alta tiene su propio puerto para
 * permanecer self-contained, igual que su `FacePhotoGrabber` previo.
 *
 * El módulo nativo es el único dueño de la cámara durante la captura. Este puerto define SOLO la
 * captura de frames (IO de cámara); el RETO de liveness lo pide la PANTALLA vía el repositorio
 * (`getLivenessChallenge`, React Query) para gobernar la máquina de estados con progreso real
 * (requesting-challenge → ready → performing). Separar reto (repo) de captura (grabber) mantiene al
 * grabber como IO puro y deja el estado reactivo en la pantalla.
 */

/**
 * Plan de captura derivado del reto del servidor: cuántos frames JPEG capturar y a qué cadencia
 * mientras el conductor ejecuta el gesto de liveness. Lo deriva `planForChallenge` (lógica pura).
 */
export interface FrameCapturePlan {
  /** Número de frames JPEG a capturar durante la acción de liveness. */
  frameCount: number;
  /** Intervalo entre frames en milisegundos. */
  intervalMs: number;
  /** Acción del reto (tipada, NO string suelto): guía al nativo y al cue direccional de la pantalla. */
  action: LivenessAction;
}

/**
 * Reportador de progreso REAL de la captura (0..1). La pantalla lo usa para llenar el anillo/barra
 * mientras el nativo entrega frames; NO es un progreso falso por temporizador.
 */
export type FrameCaptureProgress = (ratio: number) => void;

/**
 * Puerto de captura de liveness del registro (SOLO IO de cámara). La pantalla:
 *  1. pide el reto vía el repositorio (`getLivenessChallenge`) → `challengeId` + `action` + `instructions`,
 *  2. ejecuta el gesto y captura los frames (`captureFrames(plan, onProgress)`),
 *  3. enrola `{ challengeId, frames }` y cierra el alta.
 */
export interface LivenessFrameGrabber {
  /**
   * Captura la secuencia temporal de frames JPEG (base64, sin encabezado data URI) siguiendo el plan
   * derivado del reto, reportando progreso real. Abre y libera la cámara frontal. Nunca devuelve
   * frames vacíos: un vacío es un fallo de captura tipado.
   */
  captureFrames(plan: FrameCapturePlan, onProgress?: FrameCaptureProgress): Promise<string[]>;
}

/**
 * Frames por acción de liveness. Es un `Record<LivenessAction, number>` EXHAUSTIVO (no `Record<string,
 * number>` con default): si el backend agrega una acción nueva a `LivenessAction`, este mapa deja de
 * compilar hasta que se decida su conteo — la deriva es un ERROR DE COMPILACIÓN, no un default mudo.
 *
 * Elección de conteo y cadencia (total ≈ frameCount × intervalMs ≈ 2.4s, ventana cómoda para ejecutar
 * el gesto sin saturar el upload):
 *  - TURN_LEFT / TURN_RIGHT / NOD = 15 frames: gestos con recorrido (la cabeza viaja), conviene
 *    muestrear todo el arco para que el motor confirme la trayectoria, no solo dos extremos.
 *  - SMILE = 12 frames: gesto más localizado (boca/ojos), menos recorrido ⇒ algo menos de muestreo.
 */
const FRAME_COUNT_BY_ACTION: Record<LivenessAction, number> = {
  [LivenessAction.TURN_LEFT]: 15,
  [LivenessAction.TURN_RIGHT]: 15,
  [LivenessAction.NOD]: 15,
  [LivenessAction.SMILE]: 12,
};

/** Cadencia entre frames (≈6 fps): con 15 frames da ≈2.4s, ventana cómoda para ejecutar el gesto. */
const INTERVAL_MS = 160;

/**
 * Deriva el plan de captura a partir de la acción del reto. Es lógica PURA y testeable: no toca la
 * cámara ni el backend. El conteo sale del `Record` exhaustivo, así que cada acción del contrato tiene
 * un valor explícito (sin `??` default que escondería una acción nueva).
 */
export function planForChallenge(action: LivenessAction): FrameCapturePlan {
  return { frameCount: FRAME_COUNT_BY_ACTION[action], intervalMs: INTERVAL_MS, action };
}

/** Código del error cuando el módulo nativo de captura de liveness no está disponible o falla. */
export const LIVENESS_FRAME_GRABBER_UNAVAILABLE = 'LIVENESS_FRAME_GRABBER_UNAVAILABLE';

/** Error claro (no datos falsos) cuando el módulo nativo de cámara no está enlazado o no captura. */
export class LivenessFrameGrabberUnavailableError extends Error {
  readonly code = LIVENESS_FRAME_GRABBER_UNAVAILABLE;
  constructor(message = 'El módulo nativo de captura de liveness no está disponible') {
    super(message);
    this.name = 'LivenessFrameGrabberUnavailableError';
  }
}
