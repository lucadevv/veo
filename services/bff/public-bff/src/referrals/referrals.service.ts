/**
 * Referidos del pasajero (Ola 2A). Passthrough a identity-service (REST interno firmado).
 * El userId/actor se derivan SIEMPRE de la identidad autenticada.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_IDENTITY } from '../infra/downstream.tokens';

export interface ReferralSummaryView {
  code: string;
  referredCount: number;
  rewardsEarnedCents: number;
  /** Moneda de `rewardsEarnedCents` (FOUNDATION §8: Money = céntimos + currency). Hoy única 'PEN'. */
  currency: 'PEN';
}

@Injectable()
export class ReferralsService {
  constructor(@Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient) {}

  summary(user: AuthenticatedUser): Promise<ReferralSummaryView> {
    return this.identityRest.get<ReferralSummaryView>('/referrals/me', { identity: user });
  }

  redeem(user: AuthenticatedUser, code: string): Promise<ReferralSummaryView> {
    return this.identityRest.post<ReferralSummaryView>('/referrals/redeem', {
      identity: user,
      body: { code },
    });
  }
}
