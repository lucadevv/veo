import type {
  HttpClient} from '@veo/api-client';
import {
  driverOfferView,
  driverTripStateView,
  driverTripView,
  tripRoute,
} from '@veo/api-client';
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
    return this.http.get(`/dispatch/offers/${matchId}`, {schema: driverOfferView});
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
    return this.http.get(`/trips/${tripId}`, {schema: driverTripView});
  }

  getTripState(tripId: string): Promise<TripState> {
    return this.http.get(`/trips/${tripId}/state`, {schema: driverTripStateView});
  }

  getRoute(tripId: string): Promise<TripRouteView> {
    return this.http.get(`/trips/${tripId}/route`, {schema: tripRoute});
  }

  accept(tripId: string, input: AcceptTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/accept`, {body: input, schema: driverTripView});
  }

  arriving(tripId: string, input: ArrivingTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/arriving`, {body: input, schema: driverTripView});
  }

  arrived(tripId: string): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/arrived`, {body: {}, schema: driverTripView});
  }

  start(tripId: string, input: StartTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/start`, {body: input, schema: driverTripView});
  }

  complete(tripId: string, input?: CompleteTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/complete`, {body: input ?? {}, schema: driverTripView});
  }

  cancel(tripId: string, input: CancelTripInput): Promise<Trip> {
    return this.http.post(`/trips/${tripId}/cancel`, {body: input, schema: driverTripView});
  }
}
