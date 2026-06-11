/**
 * Cálculo de tarifa determinista para la PREVISUALIZACIÓN del viaje (Lima, PEN).
 *
 * Reutiliza la fórmula base de trip-service (BR-T05):
 *   tarifa = BASE + (km · POR_KM) + (min · POR_MIN)
 * y le aplica la política de pricing POR OFERTA del catálogo ADR 013 (`offering.pricing`:
 * multiplier + minFareCents). Sin surge ni recargo de modo niño: esos los fija trip-service al
 * CREAR el viaje. Este cálculo es solo para mostrar opciones antes de confirmar; el precio firme
 * sale de POST /trips.
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
import { OFFERINGS, OfferingId, VehicleClass } from '@veo/shared-types';
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

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;
  const subtotal = BASE_FARE_CENTS + PER_KM_CENTS * km + PER_MIN_CENTS * min;
  const scaled = subtotal * multiplier;
  const rounded = Math.round(scaled / FARE_ROUNDING_CENTS) * FARE_ROUNDING_CENTS;
  return Math.max(minFareCents, rounded);
}
