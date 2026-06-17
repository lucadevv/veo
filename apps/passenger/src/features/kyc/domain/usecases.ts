import type {KycChallenge, KycFrame} from './entities';
import type {KycRepository, KycSubmissionResult} from './kycRepository';

/** Error de validación de la captura KYC antes de tocar la red (SRP: la regla vive aquí). */
export class KycValidationError extends Error {
  constructor(readonly reason: 'no-challenge' | 'no-frames' | 'empty-frame') {
    super(`Captura KYC inválida: ${reason}`);
    this.name = 'KycValidationError';
  }
}

/** Mínimo y máximo de frames que aceptamos enviar (defensa de cliente; el bff revalida). */
export const MIN_KYC_FRAMES = 1;
export const MAX_KYC_FRAMES = 5;

/**
 * Pide un reto de liveness ACTIVO al servicio biométrico (acción a ejecutar + instrucción a mostrar).
 * Es el primer paso del flujo: la pantalla lo invoca al iniciar, muestra `instructions` y captura.
 * No conoce el transporte ni el contrato HTTP (DIP).
 */
export class RequestKycChallengeUseCase {
  constructor(private readonly repository: KycRepository) {}

  execute(): Promise<KycChallenge> {
    return this.repository.requestChallenge();
  }
}

/**
 * Envía la verificación de identidad: valida el `challengeId` del reto activo, que haya al menos un
 * frame no vacío, recorta al máximo permitido y delega en el repositorio. No conoce el transporte ni
 * el contrato HTTP (DIP).
 */
export class SubmitKycUseCase {
  constructor(private readonly repository: KycRepository) {}

  execute(
    challengeId: string,
    frames: KycFrame[],
  ): Promise<KycSubmissionResult> {
    if (challengeId.trim().length === 0) {
      throw new KycValidationError('no-challenge');
    }
    if (frames.length < MIN_KYC_FRAMES) {
      throw new KycValidationError('no-frames');
    }
    if (frames.some(frame => frame.base64Jpeg.trim().length === 0)) {
      throw new KycValidationError('empty-frame');
    }
    return this.repository.submit({
      challengeId,
      frames: frames.slice(0, MAX_KYC_FRAMES),
    });
  }
}
