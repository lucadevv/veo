// Entidades de dominio de Promociones/Cupones (Ola 2A). Contrato soberano en `@veo/api-client`.
export type { PromoKind, PromoValidationView } from '@veo/api-client';

/** Normaliza un código de cupón para enviarlo/compararlo: sin espacios y en MAYÚSCULAS. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Aplica un descuento (en céntimos) sobre una tarifa bruta (céntimos), nunca por debajo de 0.
 * Pura y determinista: la UI la usa para mostrar el nuevo total sin re-cotizar.
 */
export function applyDiscount(fareCents: number, discountCents: number): number {
  return Math.max(0, Math.trunc(fareCents) - Math.max(0, Math.trunc(discountCents)));
}
