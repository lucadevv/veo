import type { PromoValidationView } from './entities';
import { normalizePromoCode } from './entities';
import type { PromosRepository } from './promosRepository';

/** Error de dominio para una entrada de cupón inválida antes de tocar la red. */
export class PromoInputError extends Error {
  constructor(readonly reason: 'emptyCode' | 'noFare') {
    super(`Entrada de cupón inválida: ${reason}`);
    this.name = 'PromoInputError';
  }
}

/**
 * Valida un cupón contra la tarifa cotizada. Reglas de dominio antes de la red (SRP):
 *  - el código no puede estar vacío,
 *  - la tarifa debe ser positiva (no se valida un cupón sin cotización firme).
 * La autoridad final del descuento es el bff; aquí solo previsualizamos.
 */
export class ValidatePromoUseCase {
  constructor(private readonly repository: PromosRepository) {}

  execute(rawCode: string, fareCents: number): Promise<PromoValidationView> {
    const code = normalizePromoCode(rawCode);
    if (code.length === 0) {
      throw new PromoInputError('emptyCode');
    }
    if (!Number.isFinite(fareCents) || fareCents <= 0) {
      throw new PromoInputError('noFare');
    }
    return this.repository.validate(code, Math.trunc(fareCents));
  }
}
