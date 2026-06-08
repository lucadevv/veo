/**
 * Políticas puras del dominio de promociones/cupones (sin I/O, sin DB). Testeables como unidades.
 * El descuento se calcula SIEMPRE sobre el bruto del viaje (`grossCents`) y reduce SOLO lo que paga
 * el pasajero: la comisión de plataforma y la propina NO se ven afectadas (decisión BR — la
 * plataforma asume el costo de la promo, por eso la comisión se sigue computando sobre el bruto).
 */
import { InvalidStateError } from '@veo/utils';

export type PromoKind = 'PERCENTAGE' | 'FIXED';

/** Razón estructurada por la que una promo no aplica (la usa el BFF/app para el copy). */
export type PromoInvalidReason =
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'BELOW_MIN_FARE'
  | 'EXHAUSTED_TOTAL'
  | 'EXHAUSTED_USER';

/** Forma mínima de una promoción que necesitan las políticas puras. */
export interface PromoLike {
  kind: PromoKind;
  value: number;
  maxDiscountCents: number | null;
  minFareCents: number;
  startsAt: Date | null;
  endsAt: Date | null;
  maxTotalUses: number;
  maxUsesPerUser: number;
  active: boolean;
}

/** Normaliza un código de cupón: mayúsculas, sin espacios alrededor. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Descuento que aplica una promo sobre un bruto (céntimos). Nunca excede el bruto ni es negativo.
 *  - PERCENTAGE → floor(gross * value / 100), topado por `maxDiscountCents` (si > 0).
 *  - FIXED      → min(value, gross).
 */
export function computeDiscountCents(promo: PromoLike, fareCents: number): number {
  if (!Number.isInteger(fareCents) || fareCents < 0) {
    throw new InvalidStateError('fareCents debe ser un entero de céntimos no negativo');
  }
  let discount: number;
  if (promo.kind === 'PERCENTAGE') {
    discount = Math.floor((fareCents * promo.value) / 100);
    if (promo.maxDiscountCents && promo.maxDiscountCents > 0) {
      discount = Math.min(discount, promo.maxDiscountCents);
    }
  } else {
    discount = promo.value;
  }
  return Math.max(0, Math.min(discount, fareCents));
}

export interface PromoUsage {
  /** Canjes totales ya registrados de la promo. */
  totalUses: number;
  /** Canjes ya registrados por ESTE usuario sobre la promo. */
  userUses: number;
}

/**
 * Evalúa si una promo aplica para un usuario y un bruto dados. Devuelve `{ valid:false, reason }`
 * o `{ valid:true, discountCents }`. No lanza por condiciones de negocio (deja decidir al caller).
 */
export function evaluatePromo(
  promo: PromoLike,
  fareCents: number,
  usage: PromoUsage,
  now: Date = new Date(),
): { valid: true; discountCents: number } | { valid: false; reason: PromoInvalidReason } {
  if (!promo.active) return { valid: false, reason: 'INACTIVE' };
  if (promo.startsAt && now < promo.startsAt) return { valid: false, reason: 'NOT_STARTED' };
  if (promo.endsAt && now > promo.endsAt) return { valid: false, reason: 'EXPIRED' };
  if (promo.minFareCents > 0 && fareCents < promo.minFareCents) {
    return { valid: false, reason: 'BELOW_MIN_FARE' };
  }
  if (promo.maxTotalUses > 0 && usage.totalUses >= promo.maxTotalUses) {
    return { valid: false, reason: 'EXHAUSTED_TOTAL' };
  }
  if (usage.userUses >= Math.max(1, promo.maxUsesPerUser)) {
    return { valid: false, reason: 'EXHAUSTED_USER' };
  }
  return { valid: true, discountCents: computeDiscountCents(promo, fareCents) };
}

/** Mensaje legible (es-PE) para cada razón de invalidez. */
export function reasonMessage(reason: PromoInvalidReason): string {
  switch (reason) {
    case 'NOT_FOUND':
      return 'El código no existe';
    case 'INACTIVE':
      return 'La promoción no está activa';
    case 'NOT_STARTED':
      return 'La promoción aún no está vigente';
    case 'EXPIRED':
      return 'La promoción expiró';
    case 'BELOW_MIN_FARE':
      return 'El viaje no alcanza el monto mínimo de la promoción';
    case 'EXHAUSTED_TOTAL':
      return 'La promoción se agotó';
    case 'EXHAUSTED_USER':
      return 'Ya usaste esta promoción';
  }
}
