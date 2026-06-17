import type {ReferralSummary} from './entities';

/**
 * Abstracción del repositorio de Referidos (DIP). Implementación real contra el public-bff
 * (`GET /referrals/me`, `POST /referrals/redeem`).
 */
export interface ReferralsRepository {
  /** GET /referrals/me → resumen del programa de referidos del usuario. */
  getSummary(): Promise<ReferralSummary>;
  /** POST /referrals/redeem → canjea el código de OTRO usuario (una sola vez, no el propio). */
  redeem(code: string): Promise<ReferralSummary>;
}
