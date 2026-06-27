/**
 * BR-T05 — Cálculo de tarifa (lógica de dominio pura, sin I/O).
 *
 *   tarifa = (BASE + (POR_KM + FUEL_POR_KM)·km + POR_MIN·min) · surge   [+ FEE_NIÑO si childMode]
 *
 * Todo en céntimos PEN usando los helpers de @veo/utils. km y min se derivan de la ruta
 * que entrega @veo/maps (distanceMeters, durationSeconds). surge ∈ [1.0, 2.0] (default 1.0).
 * B3 · FUEL_POR_KM = recargo de combustible por km (admin-editable, default 0): se pliega al POR_KM
 * porque el combustible es un costo POR DISTANCIA; así escala con surge y con el multiplier de la oferta
 * (una moto ×0.55 consume menos que un XL ×1.6 — el multiplier ya aproxima el consumo por clase).
 */
import { money, scaleMoney, addMoney, type Money, ValidationError, InvalidStateError } from '@veo/utils';
import {
  CHILD_MODE_FEE_CENTS,
  type OfferingPricingPolicy,
  type OfferingSpec,
} from '@veo/shared-types';

/** Banderazo base: S/ 6.00. */
export const BASE_FARE_CENTS = 600;
/** Por kilómetro: S/ 1.20. */
export const PER_KM_CENTS = 120;
/** Por minuto: S/ 0.30. */
export const PER_MIN_CENTS = 30;
/**
 * Recargo por modo niño (BR-T07): S/ 2.00. FUENTE ÚNICA en `@veo/shared-types` (junto al catálogo de
 * pricing) — re-exportado acá para los consumidores que ya lo importan de `./fare`. El mismo número lo
 * muestra la app en el desglose ANTES de confirmar, así no diverge entre server y cliente.
 */
export { CHILD_MODE_FEE_CENTS };

export const MIN_SURGE = 1.0;
export const MAX_SURGE = 2.0;

/**
 * B4 · deriva el recargo de combustible POR KM (céntimos PEN) del precio del combustible y el rendimiento:
 *
 *   recargo/km = precio_por_litro (céntimos) ÷ rendimiento (km por litro)
 *
 * Es la fórmula estándar de costo de combustible por km. El admin ingresa el PRECIO (lo que ve en el grifo
 * y cambia seguido); el rendimiento es ~constante (vehículo de referencia). DEGRADACIÓN HONESTA: rendimiento
 * ≤ 0 o no-finito → 0 (sin recargo, NO división por cero). El per-km derivado luego se pliega al per-km de
 * la tarifa y escala con el multiplier de la oferta (una moto consume menos que un XL).
 * DEUDA: rendimiento GLOBAL (vehículo de referencia) · per-clase (moto ~40 / auto ~12 / XL ~8 km/L) sería más exacto · gatillo: si el multiplier deja de aproximar bien el consumo por clase (Tier 3)
 */
export function deriveFuelPerKmCents(pricePerLiterCents: number, kmPerLiter: number): number {
  if (!Number.isFinite(pricePerLiterCents) || pricePerLiterCents < 0) return 0;
  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) return 0;
  return Math.round(pricePerLiterCents / kmPerLiter);
}

/**
 * F2.1b · costo de energía por km AUTORITATIVO (flip ON) para una oferta, dado el precio de su fuente.
 * A diferencia del shadow, `priceOrNull === null` (fuente sin cargar) NO cae a 0: el create cobraría de
 * menos (~13% en rutas largas). Es config inválida del operador → InvalidStateError (fail-LOUD, nunca
 * silencioso). UNA definición del invariante, compartida por createTrip, changeDestination y el re-quote
 * de parada (mid-trip) — los tres caminos que cotizan una tarifa firme.
 */
export function authoritativeEnergyPerKmCents(
  offering: OfferingSpec,
  priceOrNull: number | null,
): number {
  if (priceOrNull === null) {
    throw new InvalidStateError(
      'Modelo de energía activo pero sin precio para la fuente de la oferta — poblá el catálogo',
      { offering: offering.id, energySource: offering.referenceEnergySourceId },
    );
  }
  return deriveFuelPerKmCents(priceOrNull, offering.referenceEfficiency);
}

export interface FareInput {
  distanceMeters: number;
  durationSeconds: number;
  /** Multiplicador de demanda calculado por dispatch (1.0–2.0). Default 1.0. */
  surgeMultiplier?: number;
  childMode?: boolean;
  /** B3 · recargo de combustible por km (céntimos PEN ≥ 0), admin-editable. Default 0 (sin recargo). */
  fuelPerKmCents?: number;
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
 * Calcula la tarifa total en céntimos PEN. Lanza ValidationError si los insumos son inválidos
 * (distancia/duración negativas, surge fuera de rango o fuel per km negativo).
 */
export function calculateFare(input: FareInput): Money {
  const { distanceMeters, durationSeconds } = input;
  const surge = input.surgeMultiplier ?? 1.0;
  const childMode = input.childMode ?? false;
  const fuelPerKmCents = input.fuelPerKmCents ?? 0;
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
  if (fuelPerKmCents < 0 || !Number.isFinite(fuelPerKmCents)) {
    throw new ValidationError('fuelPerKmCents inválido (≥ 0)', { fuelPerKmCents });
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

  // B3 · el recargo de combustible se pliega al costo POR KM (ver cabecera): es costo por distancia.
  const subtotalCents = Math.round(
    baseFareCents + (perKmCents + fuelPerKmCents) * km + perMinCents * min,
  );
  const surged = scaleMoney(money(subtotalCents), surge);
  return childMode ? addMoney(surged, money(CHILD_MODE_FEE_CENTS)) : surged;
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
 * B5-1 · fórmula NUEVA (energía pass-through · multiplier SOLO posicionamiento). Reemplaza al par
 * calculateFare+applyOfferingPricing, separando los 3 conceptos que el modelo viejo conflacionaba:
 *
 *   servicio   = BASE + POR_KM·km + POR_MIN·min          (la matemática base, sin energía)
 *   posicionado= servicio × multiplier                    (el multiplier escala SOLO el servicio)
 *   conEnergía = posicionado + energyPerKm·km             (la energía es COSTO PASS-THROUGH, no marcada-up)
 *   tarifa     = max(round(conEnergía × surge), minFare)  [+ FEE_NIÑO flat si childMode]
 *
 * `energyPerKmCents` = costo de energía por km DERIVADO de EnergyCatalog (precio ÷ rendimiento de la
 * oferta), inyectado por el caller (B5-1.b). NO se activa hasta el flip (B5-1.d); por ahora solo la usa
 * el shadow-compare. El fee de niño pasa a ser FLAT (antes lo escalaban multiplier y surge — otra
 * conflación que este modelo corrige). Lanza ValidationError con los mismos guards que calculateFare.
 */
export function calculateOfferingFare(
  input: FareInput,
  pricing: OfferingPricingPolicy,
  energyPerKmCents = 0,
): Money {
  const { distanceMeters, durationSeconds } = input;
  const surge = input.surgeMultiplier ?? 1.0;
  const childMode = input.childMode ?? false;

  if (distanceMeters < 0 || !Number.isFinite(distanceMeters)) {
    throw new ValidationError('distanceMeters inválida', { distanceMeters });
  }
  if (durationSeconds < 0 || !Number.isFinite(durationSeconds)) {
    throw new ValidationError('durationSeconds inválida', { durationSeconds });
  }
  if (surge < MIN_SURGE || surge > MAX_SURGE) {
    throw new ValidationError('surgeMultiplier fuera de rango [1.0, 2.0]', { surge });
  }
  if (energyPerKmCents < 0 || !Number.isFinite(energyPerKmCents)) {
    throw new ValidationError('energyPerKmCents inválido (≥ 0)', { energyPerKmCents });
  }

  // F2.4 · tarifa base configurable (default = constantes de código → retro-compat).
  const baseFareCents = input.baseFareCents ?? BASE_FARE_CENTS;
  const perKmCents = input.perKmCents ?? PER_KM_CENTS;
  const perMinCents = input.perMinCents ?? PER_MIN_CENTS;
  if (!isValidFareBase(baseFareCents, perKmCents, perMinCents)) {
    throw new ValidationError('tarifa base inválida (banderazo/km/min ≥ 0, finitos)', {
      baseFareCents,
      perKmCents,
      perMinCents,
    });
  }

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;

  const service = baseFareCents + perKmCents * km + perMinCents * min;
  const positioned = service * pricing.multiplier; // posicionamiento (NO toca la energía)
  const withEnergy = positioned + energyPerKmCents * km; // energía pass-through
  const surged = Math.round(withEnergy * surge);
  const firm = Math.max(surged, pricing.minFareCents);
  return childMode ? money(firm + CHILD_MODE_FEE_CENTS) : money(firm);
}

/** Delta del shadow-compare entre el modelo viejo y el nuevo (B5-1). */
export interface FareShadowDelta {
  oldCents: number;
  newCents: number;
  deltaCents: number;
}

/**
 * B5-1 · compara la tarifa VIEJA (calculateFare+applyOfferingPricing, fuel plegado al per-km y escalado
 * por el multiplier) contra la NUEVA (calculateOfferingFare, energía pass-through). Devuelve ambos +
 * el delta, para LOGUEAR antes de activar el flip (B5-1.d) — así medimos el impacto de precio sin
 * romper nada. Puro, sin I/O.
 */
export function shadowCompareFare(
  input: FareInput,
  pricing: OfferingPricingPolicy,
  oldFuelPerKmCents: number,
  newEnergyPerKmCents: number,
): FareShadowDelta {
  const oldCents = applyOfferingPricing(
    calculateFare({ ...input, fuelPerKmCents: oldFuelPerKmCents }),
    pricing,
  ).cents;
  const newCents = calculateOfferingFare(input, pricing, newEnergyPerKmCents).cents;
  return { oldCents, newCents, deltaCents: newCents - oldCents };
}
