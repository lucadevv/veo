import type {HttpClient} from '@veo/api-client';
import type {KycChallenge} from '../domain/entities';
import {mapKycStatus} from '../domain/entities';
import type {
  KycRepository,
  KycSubmission,
  KycSubmissionResult,
} from '../domain/kycRepository';
import {
  KYC_CHALLENGE_PATH,
  KYC_SUBMIT_PATH,
  kycChallengeResponse,
  kycSubmitResponse,
} from './kycContract';

/**
 * Implementación REAL de `KycRepository` contra el public-bff.
 *
 * Envía los frames con `POST /kyc/verifications` (contrato LOCAL en `kycContract`). El endpoint
 * existe en public-bff (módulo `kyc/` → identity-service + biometric-service ONNX). Si la red falla,
 * la pantalla trata el `ApiError` como recuperable (reintentar). No es un mock: nunca inventa un
 * resultado. Valida la respuesta con el schema local y normaliza `status` a `KycStatus` de dominio.
 */
export class HttpKycRepository implements KycRepository {
  constructor(private readonly http: HttpClient) {}

  async requestChallenge(): Promise<KycChallenge> {
    // `POST /kyc/challenge` sin body: el biometric-service emite la acción de liveness a realizar.
    const response = await this.http.post(KYC_CHALLENGE_PATH, {
      schema: kycChallengeResponse,
    });
    return {
      challengeId: response.challengeId,
      action: response.action,
      instructions: response.instructions,
      expiresAt: response.expiresAt,
    };
  }

  async submit(input: KycSubmission): Promise<KycSubmissionResult> {
    const response = await this.http.post(KYC_SUBMIT_PATH, {
      body: {challengeId: input.challengeId, frames: input.frames},
      schema: kycSubmitResponse,
    });
    return {
      status: mapKycStatus(response.status),
      ...(response.verificationId
        ? {verificationId: response.verificationId}
        : {}),
      ...(response.reason ? {reason: response.reason} : {}),
    };
  }
}
