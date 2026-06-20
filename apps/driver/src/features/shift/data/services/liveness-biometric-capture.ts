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
 *  - RE-enrolamiento: reto de liveness de enrolamiento → captura de la secuencia de frames según
 *    `action` → `POST /drivers/biometric/enroll` con `{ challengeId, frames }` (anti-spoofing).
 *
 * No es un mock: los frames provienen de la cámara real y los veredictos los emite el backend. Los
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
    // 1) Reto de liveness de ENROLAMIENTO (puede lanzar BiometricLocked/Unavailable). Distinto endpoint
    //    que el reto del turno; el alta y el re-enrolamiento comparten el mismo contrato de liveness.
    const challenge = await this.backend.requestEnrollChallenge();

    // 2) Captura REAL de la secuencia de frames guiada por la acción del reto (mismo plan que el turno).
    const plan = planForChallenge(challenge.action);
    const frames = await this.grabber.captureSequence(plan);

    // 3) RE-enrola el rostro de referencia con `{ challengeId, frames }` (anti-spoofing).
    return this.backend.enroll({ challengeId: challenge.challengeId, frames });
  }
}
