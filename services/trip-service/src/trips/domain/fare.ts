/**
 * BR-T05 — Cálculo de tarifa (lógica de dominio pura, sin I/O). Dos piezas:
 *
 *   calculateFare     = (BASE + POR_KM·km + POR_MIN·min) · surge           (la base, SIN fee de niño)
 *   calculateFirmFare = max(base × multiplier, mínima) + FEE_NIÑO(plano)   (la tarifa FIRME de la oferta)
 *
 * El FEE_NIÑO es PLANO: se suma al FINAL, así NO lo escala el multiplier de la oferta ni el surge — un
 * asiento de niño cuesta igual en cualquier tier, y es el mismo número que la app muestra en el desglose.
 * Todo en céntimos PEN (@veo/utils). km/min salen de la ruta de @veo/maps. surge ∈ [1.0, 2.0] (default 1.0).
 */
import { money, scaleMoney, addMoney, type Money, ValidationError } from '@veo/utils';
import { CHILD_MODE_FEE_CENTS, type OfferingPricingPolicy } from '@veo/shared-types';

/** Banderazo base: S/ 6.00. */
export const BASE_FARE_CENTS = 600;
/** Por kilómetro: S/ 1.20. */
export const PER_KM_CENTS = 120;
/** Por minuto: S/ 0.30. */
export const PER_MIN_CENTS = 30;
/**
 * Recargo por modo niño (BR-T07): S/ 2.00. FUENTE ÚNICA en `@veo/shared-types` (junto al catálogo de
 * pricing) — re-exportado acá para los consumidores que ya lo importan de `./fare`. Se cobra PLANO
 * (`calculateFirmFare` lo suma al final, sin escalarlo el multiplier ni el surge): así el número cobrado
 * coincide EXACTO con el que la app muestra en el desglose ANTES de confirmar.
 */
export { CHILD_MODE_FEE_CENTS };

export const MIN_SURGE = 1.0;
export const MAX_SURGE = 2.0;

export interface FareInput {
  distanceMeters: number;
  durationSeconds: number;
  /** Multiplicador de demanda calculado por dispatch (1.0–2.0). Default 1.0. */
  surgeMultiplier?: number;
  /** BR-T07 · modo niño. El recargo (FEE_NIÑO) lo aplica `calculateFirmFare` PLANO al final — NO `calculateFare`. */
  childMode?: boolean;
  /**
   * F2.4 · tarifa base configurable por el admin (`BaseFareConfig`, céntimos PEN). Default = las constantes
   * de código (banderazo/km/min), para retro-compat: un caller que NO resuelve la config cobra lo de siempre.
   * El caller que SÍ lee `BaseFareService` inyecta el triple → la tarifa real refleja lo que el admin editó.
   */
  baseFareCents?: number;
  perKmCents?: number;
  perMinCents?: number;
}

/** F2.4 · valida el triple de la tarifa base (banderazo/km/min): finitos y ≥ 0. */
function isValidFareBase(baseFareCents: number, perKmCents: number, perMinCents: number): boolean {
  return (
    Number.isFinite(baseFareCents) &&
    baseFareCents >= 0 &&
    Number.isFinite(perKmCents) &&
    perKmCents >= 0 &&
    Number.isFinite(perMinCents) &&
    perMinCents >= 0
  );
}

/**
 * Calcula la tarifa BASE en céntimos PEN (banderazo + km + min, con surge). SIN el fee de niño ni el
 * multiplier de la oferta — esos los aplica `calculateFirmFare`. Lanza ValidationError si los insumos son
 * inválidos (distancia/duración negativas o surge fuera de rango).
 */
export function calculateFare(input: FareInput): Money {
  const { distanceMeters, durationSeconds } = input;
  const surge = input.surgeMultiplier ?? 1.0;
  // F2.4 · tarifa base configurable (default = constantes de código → retro-compat).
  const baseFareCents = input.baseFareCents ?? BASE_FARE_CENTS;
  const perKmCents = input.perKmCents ?? PER_KM_CENTS;
  const perMinCents = input.perMinCents ?? PER_MIN_CENTS;

  if (distanceMeters < 0 || !Number.isFinite(distanceMeters)) {
    throw new ValidationError('distanceMeters inválida', { distanceMeters });
  }
  if (durationSeconds < 0 || !Number.isFinite(durationSeconds)) {
    throw new ValidationError('durationSeconds inválida', { durationSeconds });
  }
  if (surge < MIN_SURGE || surge > MAX_SURGE) {
    throw new ValidationError('surgeMultiplier fuera de rango [1.0, 2.0]', { surge });
  }
  // F2.4 · defensa en profundidad: el DTO ya valida @Min(0) al ESCRIBIR la config, pero la fórmula no confía
  // en su insumo (puede venir de un reply interno malformado) → un triple inválido falla FUERTE, no produce NaN.
  if (!isValidFareBase(baseFareCents, perKmCents, perMinCents)) {
    throw new ValidationError('tarifa base inválida (banderazo/km/min ≥ 0, finitos)', {
      baseFareCents,
      perKmCents,
      perMinCents,
    });
  }

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;

  const subtotalCents = Math.round(baseFareCents + perKmCents * km + perMinCents * min);
  // El FEE_NIÑO NO se suma acá: es PLANO y lo aplica `calculateFirmFare` DESPUÉS del multiplier de la oferta,
  // para que un tier premium (×1.8) no escale el recargo de un asiento que cuesta igual en todos los tiers.
  return scaleMoney(money(subtotalCents), surge);
}

/**
 * ADR 013 §1.7 — aplica la política de pricing de la OFERTA (catálogo de @veo/shared-types, fuente
 * única) a una tarifa BASE BR-T05:
 *
 *   tarifa firme = max(round(base × pricing.multiplier), pricing.minFareCents)
 *
 * FUENTE ÚNICA de la fórmula "tarifa firme desde base": la consumen FixedDispatchStrategy (tarifa
 * del create FIXED) y el re-quote de la parada mid-trip (WaypointProposalService). NO se copia la
 * fórmula a mano en ningún otro lado: si la política cambia, cambia ACÁ. Redondeo a céntimos
 * ENTEROS vía `scaleMoney` (Math.round) — la misma convención del surge de `calculateFare`.
 */
export function applyOfferingPricing(base: Money, pricing: OfferingPricingPolicy): Money {
  const scaled = scaleMoney(base, pricing.multiplier);
  return money(Math.max(scaled.cents, pricing.minFareCents), base.currency);
}

/**
 * BR-T05 + BR-T07 — tarifa FIRME de una oferta: `applyOfferingPricing(calculateFare(input), pricing)` MÁS el
 * FEE_NIÑO PLANO. FUENTE ÚNICA del cobro FIXED (FixedDispatchStrategy) y del re-quote de la parada mid-trip
 * (WaypointProposalService + changeDestination): NO se compone la fórmula a mano en ningún otro lado. El fee
 * de niño se suma AL FINAL para que ni el multiplier de la oferta ni el surge lo escalen (un asiento de niño
 * cuesta S/2.00 en moto o en premium por igual, y es el número que la app muestra en el desglose). PUJA no
 * pasa por acá: el bid ES el fareCents, sin add-ons.
 */
export function calculateFirmFare(input: FareInput, pricing: OfferingPricingPolicy): Money {
  const firm = applyOfferingPricing(calculateFare(input), pricing);
  return input.childMode ? addMoney(firm, money(CHILD_MODE_FEE_CENTS)) : firm;
}
