/**
 * Cálculo de tarifa determinista para la PREVISUALIZACIÓN del viaje (Lima, PEN).
 *
 * Reutiliza la fórmula base de trip-service (BR-T05):
 *   tarifa = BASE + (km · POR_KM) + (min · POR_MIN)
 * y le aplica un multiplicador por categoría de vehículo (VEO Económico/Confort/XL).
 * Sin surge ni recargo de modo niño: esos los fija trip-service al CREAR el viaje. Este cálculo
 * es solo para mostrar opciones antes de confirmar; el precio firme sale de POST /trips.
 *
 * NADA aleatorio: km y min provienen de la ruta real de OSRM (distanceMeters/durationSeconds).
 * Todo en céntimos PEN (enteros). Estas constantes ESPEJAN las de trip-service/domain/fare.ts.
 */
import { ValidationError } from '@veo/utils';

/** Banderazo base: S/ 6.00 (igual que trip-service). */
export const BASE_FARE_CENTS = 600;
/** Por kilómetro: S/ 1.20. */
export const PER_KM_CENTS = 120;
/** Por minuto: S/ 0.30. */
export const PER_MIN_CENTS = 30;
/** Tarifa mínima cobrable: S/ 5.00 (viajes muy cortos). */
export const MIN_FARE_CENTS = 500;
/** Redondeo del precio final a S/ 0.10 (10 céntimos) para precios "limpios". */
export const FARE_ROUNDING_CENTS = 10;

/**
 * Piso global de la PUJA (ADR 010 §9.3 / ADR 011 M4): S/ 7.00. ESPEJA el `BID_FLOOR_CENTS` de
 * trip-service (`DEFAULT_BID_FLOOR_CENTS = 700`). En modo PUJA el quote lo expone como `bidFloorCents`
 * para que la app no deje proponer por debajo del piso de la zona. MVP global (per-zona pendiente);
 * sobreescribible por env `BID_FLOOR_CENTS` para mantenerlo en sync con trip-service sin redeploy.
 */
export const DEFAULT_BID_FLOOR_CENTS = 700;

/** Categoría de vehículo seleccionable en la cotización. */
export interface RideCategory {
  /** Identificador estable (se envía luego al crear el viaje si se requiere). */
  id: string;
  /** Nombre visible para el pasajero. */
  name: string;
  /** Multiplicador sobre la tarifa base. VEO Económico = 1.0 (referencia). */
  multiplier: number;
  /**
   * Tipo de vehículo de la categoría (Ola 2B). El BFF lo propaga a trip-service como `vehicleType`
   * para que dispatch filtre el matching por tipo (MOTO solo a conductores MOTO). Default CAR.
   */
  vehicleType: 'CAR' | 'MOTO';
}

/**
 * Catálogo de categorías. El orden refleja la prioridad de presentación (moto → económico → premium).
 * Multiplicadores deterministas y comentados; no dependen de demanda ni de azar.
 *
 * Ola 2B · tier MOTO (mototaxi): el más barato. multiplier 0.55 sobre la base CAR (Económico = 1.0).
 * Es razonable para Lima: una carrera corta de mototaxi cuesta ~la mitad que un auto económico. Aun
 * con el multiplier bajo, MIN_FARE_CENTS (S/5.00) acota el precio mínimo de viajes muy cortos; para
 * mototaxi conviene una mínima menor, así que se aplica una mínima propia por categoría (ver abajo).
 */
export const RIDE_CATEGORIES: readonly RideCategory[] = [
  { id: 'veo_moto', name: 'VEO Moto', multiplier: 0.55, vehicleType: 'MOTO' },
  { id: 'veo_economico', name: 'VEO Económico', multiplier: 1.0, vehicleType: 'CAR' },
  { id: 'veo_confort', name: 'VEO Confort', multiplier: 1.25, vehicleType: 'CAR' },
  { id: 'veo_xl', name: 'VEO XL', multiplier: 1.6, vehicleType: 'CAR' },
] as const;

/** Tarifa mínima del tier moto-taxi: S/ 3.00 (más barata que la mínima general de auto). */
export const MOTO_MIN_FARE_CENTS = 300;

/** Resuelve la tarifa mínima aplicable por categoría (mototaxi tiene una mínima menor). */
export function minFareForCategory(vehicleType: 'CAR' | 'MOTO'): number {
  return vehicleType === 'MOTO' ? MOTO_MIN_FARE_CENTS : MIN_FARE_CENTS;
}

/**
 * Calcula el precio (céntimos PEN) de una categoría a partir de la distancia y duración reales.
 * Aplica el multiplicador, redondea a S/ 0.10 y respeta la tarifa mínima.
 * Lanza `ValidationError` si los insumos son negativos o no finitos.
 */
export function categoryFareCents(
  distanceMeters: number,
  durationSeconds: number,
  multiplier: number,
  /** Tarifa mínima aplicable (Ola 2B: el tier moto-taxi usa una mínima menor). Default MIN_FARE_CENTS. */
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
