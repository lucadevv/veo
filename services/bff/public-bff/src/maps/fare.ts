/**
 * Cálculo de tarifa determinista para la PREVISUALIZACIÓN del viaje (Lima, PEN).
 *
 * Reutiliza la fórmula base de trip-service (BR-T05):
 *   tarifa = BASE + (km · POR_KM) + (min · POR_MIN)
 * y le aplica la política de pricing POR OFERTA del catálogo ADR 013 (`offering.pricing`:
 * multiplier + minFareCents) + el surge AUTORITATIVO (ADR-021 Fase C · BR-T06). El surge se resuelve
 * server-side (dispatch.getSurge sobre el ORIGEN, el MISMO que usa createTrip) y se pasa acá para que el
 * preview FIXED muestre lo que el create va a cobrar — cierra el sobrecobro silencioso quote↔create. Solo
 * FIXED: en PUJA el bid ES el precio (surge irrelevante), el caller pasa surge=1.0. El recargo de modo niño
 * NO se aplica acá (la app lo muestra en el desglose ANTES de confirmar). Este cálculo es solo para mostrar
 * opciones antes de confirmar; el precio firme sale de POST /trips.
 *
 * NADA aleatorio: km y min provienen de la ruta real de OSRM (distanceMeters/durationSeconds).
 * Todo en céntimos PEN (enteros).
 *
 * ADR 013 (Lote C) · la tabla de categorías (multiplicadores, mínimas y el mapeo
 * category→vehicleType) YA NO se define acá: vive en `OFFERINGS`/`OFFERING_LIST` de
 * @veo/shared-types, la MISMA fuente que consume trip-service. Ya no existe el "espejo de
 * constantes BFF↔trip-service" para el pricing por oferta — hay UNA fuente y no puede divergir.
 * Las constantes de la fórmula base (banderazo/km/min/redondeo) sí siguen espejando
 * `trip-service/domain/fare.ts` (BR-T05): son la matemática, no la política por oferta.
 */
import { OFFERINGS, OfferingId, VehicleClass, MIN_SURGE, MAX_SURGE } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';

/** Banderazo base: S/ 6.00 (igual que trip-service). */
export const BASE_FARE_CENTS = 600;
/** Por kilómetro: S/ 1.20. */
export const PER_KM_CENTS = 120;
/** Por minuto: S/ 0.30. */
export const PER_MIN_CENTS = 30;
/**
 * Tarifa mínima general (ofertas de auto): S/ 5.00. DERIVADA del catálogo (oferta ancla
 * VEO Económico, ADR 013) — el valor ya no se define acá, se importa.
 */
export const MIN_FARE_CENTS = OFFERINGS[OfferingId.VEO_ECONOMICO].pricing.minFareCents;
/**
 * Tarifa mínima del tier moto-taxi: S/ 3.00 (más barata que la mínima de auto). DERIVADA del
 * catálogo (oferta VEO Moto, ADR 013).
 */
export const MOTO_MIN_FARE_CENTS = OFFERINGS[OfferingId.VEO_MOTO].pricing.minFareCents;
/** Redondeo del precio final a S/ 0.10 (10 céntimos) para precios "limpios". */
export const FARE_ROUNDING_CENTS = 10;

/**
 * Piso global de la PUJA (ADR 010 §9.3 / ADR 011 M4): S/ 7.00. ESPEJA el `BID_FLOOR_CENTS` de
 * trip-service (`DEFAULT_BID_FLOOR_CENTS = 700`). En modo PUJA el quote lo expone como `bidFloorCents`
 * para que la app no deje proponer por debajo del piso de la zona. MVP global (per-zona pendiente);
 * sobreescribible por env `BID_FLOOR_CENTS` para mantenerlo en sync con trip-service sin redeploy.
 */
export const DEFAULT_BID_FLOOR_CENTS = 700;

/**
 * Resuelve la tarifa mínima aplicable por CLASE de vehículo (el mototaxi tiene una mínima menor).
 * Las mínimas se derivan del catálogo (ADR 013). El quote alimenta `categoryFareCents` DIRECTO
 * desde `offering.pricing.minFareCents`; esta función queda como matemática del preview para
 * consumidores que razonan por clase, no por oferta.
 */
export function minFareForCategory(vehicleClass: VehicleClass): number {
  return vehicleClass === VehicleClass.MOTO ? MOTO_MIN_FARE_CENTS : MIN_FARE_CENTS;
}

/**
 * F2.4 · banderazo/km/min configurables por el admin (`BaseFareConfig`, céntimos PEN). El QUOTE los lee de
 * trip-service y los pasa a la fórmula para que el preview muestre lo que el create FIXED va a cobrar (anti
 * divergencia preview-vs-cobro). Default = las constantes de código (= el seed) → degradación honesta.
 */
export interface FareBase {
  baseFareCents: number;
  perKmCents: number;
  perMinCents: number;
}
export const DEFAULT_FARE_BASE: FareBase = {
  baseFareCents: BASE_FARE_CENTS,
  perKmCents: PER_KM_CENTS,
  perMinCents: PER_MIN_CENTS,
};

/**
 * Calcula el precio (céntimos PEN) de una oferta a partir de la distancia y duración reales.
 * Aplica el multiplicador, redondea a S/ 0.10 y respeta la tarifa mínima. Los insumos de política
 * (`multiplier`, `minFareCents`) vienen de `offering.pricing` del catálogo (ADR 013).
 * Lanza `ValidationError` si los insumos son negativos o no finitos.
 */
export function categoryFareCents(
  distanceMeters: number,
  durationSeconds: number,
  multiplier: number,
  /** Tarifa mínima aplicable (`offering.pricing.minFareCents`). Default MIN_FARE_CENTS (auto). */
  minFareCents: number = MIN_FARE_CENTS,
  /** B3 · recargo de combustible por km (céntimos PEN, admin). Default 0. Se pliega al per-km (espejo
   *  de trip-service domain/fare.ts) para que el preview muestre lo que el create FIXED va a cobrar. */
  fuelPerKmCents = 0,
  /** F2.4 · banderazo/km/min vigentes (config admin). Default = constantes de código. */
  fareBase: FareBase = DEFAULT_FARE_BASE,
  /** ADR-021 Fase C · surge autoritativo [1.0, 2.0] resuelto server-side (dispatch). Default 1.0 (sin recargo).
   *  Solo FIXED; en PUJA el caller pasa 1.0 (el bid ES el precio). Espeja el `× surge` de trip-service. */
  surgeMultiplier: number = MIN_SURGE,
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new ValidationError('distanceMeters inválida', { distanceMeters });
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new ValidationError('durationSeconds inválida', { durationSeconds });
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new ValidationError('multiplier inválido', { multiplier });
  }
  if (!Number.isFinite(fuelPerKmCents) || fuelPerKmCents < 0) {
    throw new ValidationError('fuelPerKmCents inválido (≥ 0)', { fuelPerKmCents });
  }
  if (!Number.isFinite(surgeMultiplier) || surgeMultiplier < MIN_SURGE || surgeMultiplier > MAX_SURGE) {
    throw new ValidationError('surgeMultiplier fuera de rango [1.0, 2.0]', { surgeMultiplier });
  }

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;
  // B3 · el recargo de combustible se pliega al per-km (es costo por distancia), igual que en trip-service.
  const subtotal =
    fareBase.baseFareCents + (fareBase.perKmCents + fuelPerKmCents) * km + fareBase.perMinCents * min;
  // ADR-021 Fase C · el surge escala la tarifa igual que en el cobro firme (trip-service `calculateFare`:
  // `subtotal × surge`), aplicado junto al multiplier de la oferta. El redondeo a S/0.10 del preview es
  // pre-existente (el cobro firme redondea al céntimo; la diferencia ≤ S/0.10 es otro eje — P-C C1/RC2).
  const scaled = subtotal * multiplier * surgeMultiplier;
  const rounded = Math.round(scaled / FARE_ROUNDING_CENTS) * FARE_ROUNDING_CENTS;
  return Math.max(minFareCents, rounded);
}

/**
 * B5-1 · ESPEJO del quote para la fórmula NUEVA (energía pass-through · multiplier solo posición) — debe
 * coincidir con `calculateOfferingFare` de trip-service (sin surge, que es create-time). Separa el
 * servicio (escalado por multiplier) del costo de energía (pass-through, NO marcado-up):
 *   servicio   = (BASE + POR_KM·km + POR_MIN·min) × multiplier
 *   total      = servicio + energyPerKm·km
 *   precio     = max(minFare, round(total a S/0.10))
 * `energyPerKmCents` = precio_energía(fuente de la oferta) ÷ rendimiento de la oferta (lo deriva el caller,
 * B5-1.b). NO se activa hasta el flip (B5-1.d); por ahora solo la usa el shadow-compare del quote.
 */
export function categoryFareCentsV2(
  distanceMeters: number,
  durationSeconds: number,
  multiplier: number,
  minFareCents: number = MIN_FARE_CENTS,
  energyPerKmCents = 0,
  /** F2.4 · banderazo/km/min vigentes (config admin). Default = constantes de código. */
  fareBase: FareBase = DEFAULT_FARE_BASE,
  /** ADR-021 Fase C · surge autoritativo [1.0, 2.0]. Default 1.0. Espeja el `× surge` de `calculateOfferingFare`
   *  (trip-service): escala el total (servicio + energía) ANTES de redondear. Solo FIXED (PUJA → 1.0). */
  surgeMultiplier: number = MIN_SURGE,
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new ValidationError('distanceMeters inválida', { distanceMeters });
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new ValidationError('durationSeconds inválida', { durationSeconds });
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new ValidationError('multiplier inválido', { multiplier });
  }
  if (!Number.isFinite(energyPerKmCents) || energyPerKmCents < 0) {
    throw new ValidationError('energyPerKmCents inválido (≥ 0)', { energyPerKmCents });
  }
  if (!Number.isFinite(surgeMultiplier) || surgeMultiplier < MIN_SURGE || surgeMultiplier > MAX_SURGE) {
    throw new ValidationError('surgeMultiplier fuera de rango [1.0, 2.0]', { surgeMultiplier });
  }

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;
  const service =
    (fareBase.baseFareCents + fareBase.perKmCents * km + fareBase.perMinCents * min) * multiplier; // posicionamiento
  const total = service + energyPerKmCents * km; // energía pass-through (no ×multiplier)
  // ADR-021 Fase C · el surge escala el total ANTES del redondeo, igual que `calculateOfferingFare` de
  // trip-service (`round((posicionado + energía) × surge)`).
  const rounded = Math.round((total * surgeMultiplier) / FARE_ROUNDING_CENTS) * FARE_ROUNDING_CENTS;
  return Math.max(minFareCents, rounded);
}

/**
 * B5-1 · costo de energía por km DERIVADO = precio_por_unidad ÷ rendimiento (km por unidad). Mismo cálculo
 * que `deriveFuelPerKmCents` de trip-service (precio÷rendimiento, ≤0 → 0). Unifica líquido y eléctrico.
 */
export function deriveEnergyPerKmCents(
  pricePerUnitCents: number,
  efficiencyKmPerUnit: number,
): number {
  if (!Number.isFinite(pricePerUnitCents) || pricePerUnitCents < 0) return 0;
  if (!Number.isFinite(efficiencyKmPerUnit) || efficiencyKmPerUnit <= 0) return 0;
  return Math.round(pricePerUnitCents / efficiencyKmPerUnit);
}

/** Delta del shadow-compare del quote entre el modelo viejo y el nuevo (B5-1). */
export interface QuoteShadowDelta {
  oldCents: number;
  newCents: number;
  deltaCents: number;
}

/**
 * B5-1 · compara el precio del quote VIEJO (categoryFareCents, fuel plegado y ×multiplier) contra el
 * NUEVO (categoryFareCentsV2, energía pass-through). Para LOGUEAR el delta por oferta en el quote antes
 * de activar el flip — medimos el impacto sin cambiar lo que el pasajero paga. Puro.
 */
export function shadowCompareCategoryFare(
  distanceMeters: number,
  durationSeconds: number,
  multiplier: number,
  minFareCents: number,
  oldFuelPerKmCents: number,
  newEnergyPerKmCents: number,
  /** F2.4 · banderazo/km/min vigentes — el MISMO para ambas fórmulas (el delta aísla energía, no la base). */
  fareBase: FareBase = DEFAULT_FARE_BASE,
): QuoteShadowDelta {
  const oldCents = categoryFareCents(
    distanceMeters,
    durationSeconds,
    multiplier,
    minFareCents,
    oldFuelPerKmCents,
    fareBase,
  );
  const newCents = categoryFareCentsV2(
    distanceMeters,
    durationSeconds,
    multiplier,
    minFareCents,
    newEnergyPerKmCents,
    fareBase,
  );
  return { oldCents, newCents, deltaCents: newCents - oldCents };
}
