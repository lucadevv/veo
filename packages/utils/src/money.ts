/**
 * Dinero en VEO: SIEMPRE enteros de céntimos (PEN). Nunca float (FOUNDATION §8).
 * S/ 15.00 → 1500 céntimos.
 */
import { ValidationError } from './errors.js';

export type Currency = 'PEN';
export const DEFAULT_CURRENCY: Currency = 'PEN';

/**
 * Techo CANÓNICO de un bid/contraoferta de la PUJA (ADR 010) en céntimos PEN.
 *
 * Una sola carrera urbana en Lima NO puede valer más que esto (S/ 9,999). Es un GUARDARRAÍL
 * anti-abuso/anti-overflow, no un precio de negocio: `Trip.fareCents` es un `int4` de Postgres
 * (máx 2_147_483_647), así que un bid/contra desbocado (p.ej. 9_999_999_999) o bien overflowea el
 * insert o bien fluye como tarifa al cobro. 999_900 queda MUY por debajo del techo de int4.
 *
 * Fuente ÚNICA de verdad compartida por las 3 capas (public-bff DTO, trip-service DTO + dominio,
 * dispatch-service DTO + dominio). Los servicios lo exponen además como env `BID_MAX_CENTS`
 * (default = este valor) para poder ajustarlo por entorno sin recompilar; este literal es el
 * default y el valor que usan los `@Max()` de class-validator (que exigen una constante en tiempo
 * de compilación). El chequeo AUTORITATIVO es server-side (trip-service.createTrip / applyAgreedFare
 * y dispatch.submitOffer); los DTOs son la primera barrera (fail-fast en el borde).
 */
export const BID_MAX_CENTS = 999_900;

export interface Money {
  /** Monto en céntimos (enteros). 1500 = S/ 15.00 */
  cents: number;
  currency: Currency;
}

export function money(cents: number, currency: Currency = DEFAULT_CURRENCY): Money {
  if (!Number.isInteger(cents)) {
    throw new ValidationError('El monto debe ser un entero de céntimos', { cents });
  }
  return { cents, currency };
}

export function solesToCents(soles: number): number {
  return Math.round(soles * 100);
}

export function centsToSoles(cents: number): number {
  return cents / 100;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { cents: a.cents - b.cents, currency: a.currency };
}

/** Multiplica por un factor (ej. surge 1.5x) y redondea a céntimos enteros. */
export function scaleMoney(a: Money, factor: number): Money {
  return { cents: Math.round(a.cents * factor), currency: a.currency };
}

/** Comisión de plataforma: porción `rate` (0..1) del bruto, redondeada (BR-P04). */
export function commission(gross: Money, rate: number): Money {
  if (rate < 0 || rate > 1) {
    throw new ValidationError('La comisión debe estar entre 0 y 1', { rate });
  }
  return { cents: Math.round(gross.cents * rate), currency: gross.currency };
}

/** Formato peruano: 1500 → "S/ 15.00" */
export function formatPEN(cents: number): string {
  const soles = (cents / 100).toLocaleString('es-PE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `S/ ${soles}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new ValidationError('Monedas distintas', { a: a.currency, b: b.currency });
  }
}
