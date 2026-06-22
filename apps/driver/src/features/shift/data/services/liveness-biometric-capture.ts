import type {
  BiometricCaptureResult,
  BiometricCaptureService,
  BiometricEnrollmentService,
} from '../../domain/ports/biometric-capture-service';
import type {
  BiometricBackendPort,
  BiometricEnrollResult,
} from '../../domain/ports/biometric-backend';
import {
  planForChallenge,
  type BiometricFrameGrabber,
} from '../../domain/ports/biometric-frame-grabber';

/**
 * Orquestador REAL del gate biométrico de inicio de turno y del enrolamiento.
 *
 * Combina el frame-grabber nativo (cámara frontal) con el backend biométrico del driver-bff:
 *  - Inicio de turno: reto de liveness → captura de la secuencia de frames según `action` →
 *    verificación → `sessionRef` (de un solo uso) que consume `POST /drivers/shift/start`.
 *  - RE-enrolamiento: captura de UNA selfie frontal → `POST /drivers/biometric/enroll` con `{ photo }`
 *    (sin liveness; mismo contrato que el alta). El anti-suplantación vive en el face-match DNI↔selfie.
 *
 * No es un mock: los frames/foto provienen de la cámara real y los veredictos los emite el backend. Los
 * errores tipados (no enrolado, rechazado, bloqueado, no disponible) los propaga sin alterarlos.
 */
export class LivenessBiometricCaptureService
  implements BiometricCaptureService, BiometricEnrollmentService
{
  constructor(
    private readonly grabber: BiometricFrameGrabber,
    private readonly backend: BiometricBackendPort,
  ) {}

  async captureForShiftStart(): Promise<BiometricCaptureResult> {
    // 1) Reto de liveness (puede lanzar BiometricNotEnrolledError/Locked/Unavailable).
    const challenge = await this.backend.requestChallenge();

    // 2) Captura REAL de la secuencia de frames guiada por la acción del reto.
    const plan = planForChallenge(challenge.action);
    const frames = await this.grabber.captureSequence(plan);

    // 3) Verificación → sessionRef. Si liveness/match fallan, el backend port lanza BiometricRejected.
    const outcome = await this.backend.verify({ challengeId: challenge.challengeId, frames });
    return { sessionRef: outcome.sessionRef, score: outcome.score };
  }

  async enroll(): Promise<BiometricEnrollResult> {
    // RE-enrolamiento con UNA SELFIE (sin liveness): mismo flujo que el alta. Captura una sola foto
    // frontal real (módulo nativo) y la enrola con `{ photo }`. El anti-suplantación vive en el
    // face-match DNI↔selfie del binding, no en un reto girar/asentir. Sin foto real NO se enrola.
    const photo = await this.grabber.capturePhoto();
    return this.backend.enroll({ photo });
  }
}
