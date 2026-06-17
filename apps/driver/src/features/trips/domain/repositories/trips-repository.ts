import type { GeoPoint, RespondWaypointView } from '@veo/api-client';
import type {
  AcceptTripInput,
  ArrivingTripInput,
  CancelTripInput,
  CompleteTripInput,
  StartTripInput,
  Trip,
  TripOffer,
  TripRouteView,
  TripState,
} from '../entities';

/**
 * Contrato del repositorio de viajes (capa domain). Implementación concreta en `data/`.
 * Las ofertas entrantes llegan por el socket `/driver`; aceptar/rechazar y las transiciones
 * de estado se confirman por REST contra el driver-bff.
 */
export interface TripsRepository {
  /** GET /dispatch/offers/:matchId — detalle de la oferta/match. */
  getOffer(matchId: string): Promise<TripOffer>;
  /** POST /dispatch/offers/:matchId/accept — el conductor acepta la oferta entrante. */
  acceptOffer(matchId: string): Promise<void>;
  /** POST /dispatch/offers/:matchId/reject — el conductor rechaza la oferta entrante. */
  rejectOffer(matchId: string): Promise<void>;
  /** GET /trips/:id — viaje (lado conductor). */
  getTrip(tripId: string): Promise<Trip>;
  /**
   * GET /trips/active — viaje ACTIVO (vivo) de ESTE conductor, sin conocer su id. `null` si no tiene
   * ninguno en curso (el BFF responde 204). Lo usa la rehidratación tras un reinicio de la app.
   */
  getActiveTrip(): Promise<Trip | null>;
  /** GET /trips/:id/state — estado ligero del viaje. */
  getTripState(tripId: string): Promise<TripState>;
  /**
   * GET /trips/:id/route — ruta + pasos de navegación turn-by-turn del viaje activo. `from` (posición
   * ACTUAL del conductor, opcional) hace que el BFF trace la ruta desde donde está (ETA vivo + próxima
   * maniobra viva + re-ruteo por desvío). Sin `from`: ruta desde el origen del viaje.
   */
  getRoute(tripId: string, from?: GeoPoint): Promise<TripRouteView>;
  /** POST /trips/:id/accept — confirma la asignación del viaje (→ ACCEPTED). */
  accept(tripId: string, input: AcceptTripInput): Promise<Trip>;
  /** POST /trips/:id/arriving — marca "en camino al recojo" (→ ARRIVING). */
  arriving(tripId: string, input: ArrivingTripInput): Promise<Trip>;
  /** POST /trips/:id/arrived — marca "en el punto de recojo" (→ ARRIVED). */
  arrived(tripId: string): Promise<Trip>;
  /** POST /trips/:id/start — inicia el viaje (código modo niño si aplica) (→ IN_PROGRESS). */
  start(tripId: string, input: StartTripInput): Promise<Trip>;
  /**
   * POST /trips/:id/complete — finaliza el viaje (→ COMPLETED). EFECTIVO: `input.cashCollected`
   * marca el cobro en mano (driverConfirmed). Omitido ⇒ flujo bilateral normal / viaje digital.
   */
  complete(tripId: string, input?: CompleteTripInput): Promise<Trip>;
  /** POST /trips/:id/cancel — cancela (actor DRIVER fijado en el BFF). */
  cancel(tripId: string, input: CancelTripInput): Promise<Trip>;
  /**
   * POST /trips/:id/waypoints/:proposalId/respond — el conductor ACEPTA/RECHAZA una parada propuesta
   * por el pasajero durante el viaje en curso (Lote C4). El driverId lo DERIVA el BFF (anti-IDOR);
   * aceptar agrega la parada y recalcula la tarifa+ruta server-side. Devuelve el estado terminal de la
   * propuesta + la tarifa VIGENTE del viaje (la nueva si aceptó, la misma si rechazó).
   */
  respondWaypoint(
    tripId: string,
    proposalId: string,
    accept: boolean,
  ): Promise<RespondWaypointView>;
}
