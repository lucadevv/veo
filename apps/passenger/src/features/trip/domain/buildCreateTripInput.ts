import type {
  CreateTripRequest,
  GeoPoint,
  MobilePaymentMethod,
  QuoteOption,
  SpecialRequest,
} from '@veo/api-client';

/**
 * Arma el input de `createTrip` — FUENTE ÚNICA compartida por las DOS superficies de cotización: el
 * `QuotingBody` del sheet unificado y el `RouteQuoteScreen` del flujo programado (legacy). Vive acá, y
 * no duplicado en cada pantalla, para que NO vuelva a divergir: el bug de "el flujo programado no manda
 * `vehicleType` en PUJA → no podías pujar una Moto" nació JUSTO de tener este armado copiado en dos
 * lados que se desincronizaron (ARQUITECTURA §5-bis: cero duplicación; el copy-paste es deuda).
 *
 * Regla de dominio (ADR 013): la oferta se elige SIEMPRE → `category` + `vehicleType` viajan en AMBOS
 * modos. El server resuelve la oferta y DERIVA el pool de matching; el board de puja filtra por
 * `vehicleType` ("un viaje MOTO solo a MOTO"), así que mandar la categoría en PUJA es lo que habilita
 * pujar una Moto. `bidCents`/`specialRequests` SOLO si la oferta elegida resuelve PUJA. El modo
 * autoritativo lo RE-RESUELVE el server al crear el viaje (la app refleja, no decide).
 */
export interface BuildCreateTripInputParams {
  origin: GeoPoint;
  destination: GeoPoint;
  paymentMethod: MobilePaymentMethod;
  /** Id de la oferta elegida (categoría del catálogo) — `null` mientras no hay selección. */
  selectedId: string | null;
  /** La oferta elegida (de la que sale el `vehicleType` / pool de matching). */
  selectedOption: QuoteOption | null;
  /** Modo EFECTIVO de la oferta elegida (ya resuelto por el caller: `option.mode ?? quote.mode`). */
  selectedIsPuja: boolean;
  /** Oferta del pasajero en céntimos (solo aplica en PUJA). */
  bidCents: number | null;
  /** Pedidos especiales para el conductor (solo en PUJA). */
  specialRequests: SpecialRequest[];
  /** Paradas intermedias ya fijadas y convertidas a GeoPoint. */
  waypoints: GeoPoint[];
  /** Hora programada (epoch ms) o `null` = viaje inmediato. */
  scheduledAt: number | null;
  /** Cupón aplicado o `null`. */
  promoCode: string | null;
  /** Modo niño: si está activo, viaja el flag + el código. */
  childMode: { enabled: boolean; code: string };
}

export function buildCreateTripInput(p: BuildCreateTripInputParams): CreateTripRequest {
  return {
    origin: p.origin,
    destination: p.destination,
    paymentMethod: p.paymentMethod,
    // category + vehicleType en AMBOS modos: el server deriva el pool (Moto vs Auto). En PUJA es lo que
    // permite pujar una Moto (el board filtra por vehicleType).
    ...(p.selectedId ? { category: p.selectedId } : {}),
    ...(p.selectedOption ? { vehicleType: p.selectedOption.vehicleType } : {}),
    // bid + pedidos especiales SOLO si la oferta elegida resuelve PUJA.
    ...(p.selectedIsPuja && p.bidCents !== null ? { bidCents: p.bidCents } : {}),
    ...(p.selectedIsPuja && p.specialRequests.length > 0
      ? { specialRequests: p.specialRequests }
      : {}),
    ...(p.waypoints.length > 0 ? { waypoints: p.waypoints } : {}),
    ...(p.scheduledAt !== null ? { scheduledFor: new Date(p.scheduledAt).toISOString() } : {}),
    ...(p.promoCode ? { promoCode: p.promoCode } : {}),
    ...(p.childMode.enabled ? { childMode: true, childCode: p.childMode.code || undefined } : {}),
  };
}
