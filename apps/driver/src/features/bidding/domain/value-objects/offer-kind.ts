// Techo absoluto de una contraoferta (céntimos PEN). Submódulo PURO de @veo/utils (no el barrel, que
// arrastra node:crypto, inexistente en Hermes/React Native — mismo motivo que shared/presentation/format).
import { BID_MAX_CENTS } from '@veo/utils/money';

export { BID_MAX_CENTS };

/**
 * Tipo de respuesta del conductor a una puja (ADR 010 §6). `as const` (no enum, no literal suelto): un
 * único origen del valor + el tipo derivado homónimo. Espeja el OfferKind del backend.
 *  - ACCEPT_PRICE: acepta el precio del bid tal cual (priceCents === bidCents).
 *  - COUNTER:      contraoferta un precio MAYOR al bid (bidCents < priceCents ≤ techo).
 */
export const OfferKind = {
  ACCEPT_PRICE: 'ACCEPT_PRICE',
  COUNTER: 'COUNTER',
} as const;
export type OfferKind = (typeof OfferKind)[keyof typeof OfferKind];

/** Error de dominio: una contraoferta fuera del rango válido (bid, techo]. La UI lo traduce a un mensaje. */
export class InvalidCounterOfferError extends Error {
  constructor(
    readonly priceCents: number,
    readonly bidCents: number,
    readonly maxCents: number,
  ) {
    super(`La contraoferta debe ser mayor a ${bidCents} y a lo sumo ${maxCents} céntimos`);
    this.name = 'InvalidCounterOfferError';
  }
}

/**
 * Valida que una contraoferta sea estrictamente MAYOR al bid y no supere el techo. Es defensa en el
 * cliente: el gate AUTORITATIVO vive en dispatch (OfferBoardService.submitOffer). Lanza
 * `InvalidCounterOfferError` si está fuera de rango.
 */
export function assertValidCounter(priceCents: number, bidCents: number): void {
  if (!Number.isInteger(priceCents) || priceCents <= bidCents || priceCents > BID_MAX_CENTS) {
    throw new InvalidCounterOfferError(priceCents, bidCents, BID_MAX_CENTS);
  }
}

/**
 * Clampa un monto de contraoferta al rango válido [bidCents + 1, techo] para la UI (que el stepper/input
 * nunca proponga un valor que dispatch rechazaría). NO sustituye a `assertValidCounter`: redondea el borde,
 * no valida la intención.
 */
export function clampCounter(priceCents: number, bidCents: number): number {
  return Math.min(Math.max(priceCents, bidCents + 1), BID_MAX_CENTS);
}
