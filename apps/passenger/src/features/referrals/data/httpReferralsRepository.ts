import { type HttpClient, referralSummary } from '@veo/api-client';
import type { ReferralSummary } from '../domain/entities';
import type { ReferralsRepository } from '../domain/referralsRepository';

/**
 * Implementación REAL de `ReferralsRepository` contra el public-bff (`/referrals`, Ola 2A).
 *
 * Valida las respuestas con el schema SOBERANO `referralSummary` de `@veo/api-client`. El canje
 * devuelve el resumen actualizado (mismo shape que `GET /referrals/me`), así la UI refresca al toque.
 */
export class HttpReferralsRepository implements ReferralsRepository {
  constructor(private readonly http: HttpClient) {}

  getSummary(): Promise<ReferralSummary> {
    return this.http.get('/referrals/me', { schema: referralSummary });
  }

  redeem(code: string): Promise<ReferralSummary> {
    return this.http.post('/referrals/redeem', {
      body: { code },
      schema: referralSummary,
    });
  }
}
