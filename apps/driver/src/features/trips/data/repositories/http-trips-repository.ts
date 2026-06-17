import type { HttpClient } from '@veo/api-client';
import {
  driverOfferView,
  driverTripStateView,
  driverTripView,
  respondWaypointView,
  tripRoute,
} from '@veo/api-client';
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
  TripsRepository,
  TripState,
} from '../../domain';

/** Implementación HTTP del `TripsRepository` contra el driver-bff. */
export class HttpTripsRepository implements TripsRepository {
  constructor(private readonly http: HttpClient) {}

  getOffer(matchId: string): Promise<TripOffer> {
    return this.http.get(`/dispatch/offers/${matchId}`, { schema: driverOfferView });
  }

  // Las respuestas de aceptar/rechazar oferta son passthrough del dispatch-service (forma no
  // contractualizada); no se validan ni se usan: basta con el 200 OK.
  async acceptOffer(matchId: string): Promise<void> {
    await this.http.post(`/dispatch/offers/${matchId}/accept`);
  }

  async rejectOffer(matchId: string): Promise<void> {
    await this.http.post(`/dispatch/offers/${matchId}/reject`);
  }

  getTrip(tripId: string): Promise<Trip> {
    return this.http.get(`/trips/${tripId}`, { schema: driverTripView });
  }

  async getActiveTrip(): Promise<Trip | null> {
    // El BFF responde 204 (sin body) cuando el conductor no tiene viaje activo; el HttpClient lo mapea
    // a `undefined`. "Sin viaje activo" NO es error: es el caso normal fuera de un viaje.
    const trip = (await this.http.get(`/trips/active`, { schema: driverTripView })) as
      | Trip
      | undefined;
    return trip ?? null;
  }

  getTripState(tripId: string): Promise<TripState> {
    return this.http.get(`/trips/${tripId}/state`, { schema: driverTripStateView });
  }

  getRoute(tripId: string, from?: GeoPoint): Promise<TripRouteView> {
    // Si hay posición actual, la mandamos como query lat/lon → el BFF traza la ruta desde ahí (ETA vivo
    // + re-ruteo por desvío). El HttpClient arma el query string (RN no tiene URL.searchParams).
    return this.http.get(`/trips/${tripId}/route`, {
      query: from ? { lat: from.lat, lon: from.lon } : undefined,
      schema: tripRoute,
    });
  }

  accept(tripId: string, input: AcceptTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/accept`, { body: input, schema: driverTripView });
  }

  arriving(tripId: string, input: ArrivingTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/arriving`, { body: input, schema: driverTripView });
  }

  arrived(tripId: string): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/arrived`, { body: {}, schema: driverTripView });
  }

  start(tripId: string, input: StartTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/start`, { body: input, schema: driverTripView });
  }

  complete(tripId: string, input?: CompleteTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/complete`, {
      body: input ?? {},
      schema: driverTripView,
    });
  }

  cancel(tripId: string, input: CancelTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/cancel`, { body: input, schema: driverTripView });
  }

  respondWaypoint(
    tripId: string,
    proposalId: string,
    accept: boolean,
  ): Promise<RespondWaypointView> {
    // Solo viaja `accept`: el driverId lo deriva el BFF del JWT (anti-IDOR) y el recálculo de tarifa/ruta
    // es server-authoritative. El conductor nunca fija el precio.
    return this.http.post(`/trips/${tripId}/waypoints/${proposalId}/respond`, {
      body: { accept },
      schema: respondWaypointView,
    });
  }
}
