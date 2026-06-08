import {
  ApiError,
  HttpClient,
  biometricChallenge,
  biometricVerifyResult,
  driverBiometricEnrollRequest,
  driverBiometricEnrollResult,
  driverBiometricVerifyRequest,
} from '@veo/api-client';
import {
  BiometricBackendUnavailableError,
  BiometricLockedError,
  BiometricNotEnrolledError,
  BiometricRejectedError,
  type BiometricBackendPort,
  type BiometricChallenge,
  type BiometricEnrollResult,
  type BiometricVerificationInput,
  type BiometricVerifyOutcome,
} from '../../domain/ports/biometric-backend';

/**
 * Implementación HTTP del puerto biométrico contra el driver-bff (JWT driver).
 *
 * Usa los esquemas zod de `@veo/api-client` como fuente de verdad del contrato (no se redefinen
 * localmente). Traduce los códigos de estado reales a errores de dominio tipados:
 *   - 409/422 → `BiometricNotEnrolledError` (el conductor debe enrolar su rostro).
 *   - 403     → `BiometricLockedError` (bloqueo por intentos fallidos; mensaje del backend).
 *   - red/5xx → `BiometricBackendUnavailableError`.
 * Si el verify responde 200 pero `livenessPassed`/`matchPassed` son false → `BiometricRejectedError`.
 */
export class HttpBiometricBackendPort implements BiometricBackendPort {
  constructor(private readonly http: HttpClient) {}

  async requestChallenge(): Promise<BiometricChallenge> {
    try {
      return await this.http.post('/drivers/shift/biometric/challenge', {
        schema: biometricChallenge,
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async verify(input: BiometricVerificationInput): Promise<BiometricVerifyOutcome> {
    let result;
    try {
      // El cuerpo se valida con el esquema del contrato antes de enviarlo.
      const body = driverBiometricVerifyRequest.parse({
        challengeId: input.challengeId,
        frames: input.frames,
      });
      result = await this.http.post('/drivers/shift/biometric/verify', {
        body,
        schema: biometricVerifyResult,
      });
    } catch (error) {
      throw this.mapError(error);
    }
    // 200 con liveness/match fallido: el gate NO se abre (no hay sessionRef utilizable).
    if (!result.livenessPassed || !result.matchPassed) {
      throw new BiometricRejectedError(undefined, result.livenessPassed, result.matchPassed);
    }
    return result;
  }

  async enroll(photoBase64: string): Promise<BiometricEnrollResult> {
    try {
      const body = driverBiometricEnrollRequest.parse({photo: photoBase64});
      const result = await this.http.post('/drivers/biometric/enroll', {
        body,
        schema: driverBiometricEnrollResult,
      });
      return {enrolledAt: result.enrolledAt};
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** Traduce un fallo HTTP al error de dominio biométrico correspondiente. */
  private mapError(error: unknown): Error {
    if (error instanceof ApiError) {
      if (error.status === 409 || error.status === 422) {
        return new BiometricNotEnrolledError(error.message || undefined);
      }
      if (error.status === 403) {
        return new BiometricLockedError(error.message || undefined);
      }
      if (error.status === 401) {
        return new BiometricRejectedError(error.message || undefined);
      }
      return new BiometricBackendUnavailableError(error.message || undefined);
    }
    return new BiometricBackendUnavailableError(
      error instanceof Error ? error.message : undefined,
    );
  }
}
