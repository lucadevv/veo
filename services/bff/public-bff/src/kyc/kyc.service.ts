/**
 * KYC del pasajero. Reto de liveness y verificación son comandos (REST interno firmado a
 * identity-service). El BFF no almacena nada: traduce el contrato externo (frames con metadata)
 * al contrato interno (base64 plano) y reexpone el veredicto tal cual.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_IDENTITY } from '../infra/downstream.tokens';
import type { KycChallengeView, KycVerificationView, VerifyKycDto } from './dto/kyc.dto';

@Injectable()
export class KycService {
  constructor(@Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient) {}

  challenge(user: AuthenticatedUser): Promise<KycChallengeView> {
    return this.identityRest.post<KycChallengeView>('/users/kyc/challenge', {
      identity: user,
      body: {},
    });
  }

  verify(user: AuthenticatedUser, dto: VerifyKycDto): Promise<KycVerificationView> {
    // identity-service espera base64 plano; descartamos width/height/capturedAt (metadata de la app).
    const frames = dto.frames.map((f) => f.base64Jpeg);
    return this.identityRest.post<KycVerificationView>('/users/kyc/verify', {
      identity: user,
      body: { challengeId: dto.challengeId, frames },
    });
  }
}
