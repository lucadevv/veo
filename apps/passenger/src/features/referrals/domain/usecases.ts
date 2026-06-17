import type {ReferralSummary} from './entities';
import {MIN_REFERRAL_CODE_LENGTH, normalizeReferralCode} from './entities';
import type {ReferralsRepository} from './referralsRepository';

/** Motivo por el que un código de referido es inválido (mapea a una clave i18n de error). */
export type ReferralCodeReason = 'empty' | 'tooShort' | 'ownCode';

/** Error de dominio para un código de referido inválido antes de tocar la red. */
export class ReferralCodeError extends Error {
  constructor(readonly reason: ReferralCodeReason) {
    super(`Código de referido inválido: ${reason}`);
    this.name = 'ReferralCodeError';
  }
}

/** Obtiene el resumen del programa de referidos del usuario. */
export class GetReferralSummaryUseCase {
  constructor(private readonly repository: ReferralsRepository) {}

  execute(): Promise<ReferralSummary> {
    return this.repository.getSummary();
  }
}

/**
 * Canjea el código de un amigo. Valida en dominio antes de la red (SRP):
 *  - no vacío y con longitud mínima,
 *  - no es el código propio (el bff también lo rechaza; aquí damos feedback inmediato).
 * El `ownCode` es opcional: si la pantalla conoce el código propio, lo pasa para la verificación local.
 */
export class RedeemReferralUseCase {
  constructor(private readonly repository: ReferralsRepository) {}

  execute(rawCode: string, ownCode?: string): Promise<ReferralSummary> {
    const code = normalizeReferralCode(rawCode);
    if (code.length === 0) {
      throw new ReferralCodeError('empty');
    }
    if (code.length < MIN_REFERRAL_CODE_LENGTH) {
      throw new ReferralCodeError('tooShort');
    }
    if (ownCode && code === normalizeReferralCode(ownCode)) {
      throw new ReferralCodeError('ownCode');
    }
    return this.repository.redeem(code);
  }
}
