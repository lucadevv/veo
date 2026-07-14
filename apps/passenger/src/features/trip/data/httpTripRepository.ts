import {
  type CancelTripRequest,
  type CreateTripRequest,
  closeTripView,
  type CreatedShareLink,
  createdShareLink,
  type GeoPoint,
  getTripHistory,
  type HttpClient,
  type OfferList,
  pendingSettlementView,
  offerList,
  type OfferView,
  offerView,
  type RevokedShareLink,
  revokedShareLink,
  type ScheduledTripList,
  scheduledTripList,
  type ShareTripRequest,
  type SurgeQuote,
  surgeQuote,
  type TripActiveView,
  tripActiveView,
  type TripHistoryPage,
  type TripHistoryQuery,
  type TripResource,
  tripResource,
  type TripRoute,
  tripRoute,
  type TripStateView,
  tripStateView,
  type TripVideoGrant,
  tripVideoGrant,
  type WaypointProposalView,
  waypointProposalView,
} from '@veo/api-client';
import type {TripRepository} from '../domain/tripRepository';

/** Implementación de `TripRepository` contra el public-bff. */
export class HttpTripRepository implements TripRepository {
  constructor(private readonly http: HttpClient) {}

  getSurge(coords: GeoPoint): Promise<SurgeQuote> {
    return this.http.get('/dispatch/surge', {
      query: {lat: coords.lat, lon: coords.lon},
      schema: surgeQuote,
    });
  }

  createTrip(
    input: CreateTripRequest,
    idempotencyKey?: string,
  ): Promise<TripResource> {
    // IK · la key dedupea reintentos server-side (Trip.idempotencyKey @unique en trip-service).
    return this.http.post('/trips', {
      body: input,
      schema: tripResource,
      idempotencyKey,
    });
  }

  getActiveTrip(tripId: string): Promise<TripActiveView> {
    return this.http.get(`/trips/${tripId}`, {schema: tripActiveView});
  }

  async getMyActiveTrip(): Promise<TripActiveView | null> {
    // El bff responde 204 (sin body) cuando el pasajero no tiene viaje activo; el HttpClient lo
    // devuelve como `undefined` (no intenta parsear JSON). Lo normalizamos a `null` para el dominio.
    const trip = (await this.http.get('/trips/active', {
      schema: tripActiveView,
    })) as TripActiveView | undefined;
    return trip ?? null;
  }

  async getPendingSettlement(): Promise<TripActiveView | null> {
    // Mismo contrato 204→undefined que `/trips/active`: el bff responde 204 (sin body) cuando no hay
    // cierre pendiente. Lo normalizamos a `null` para el dominio.
    const trip = (await this.http.get('/trips/pending-settlement', {
      schema: pendingSettlementView,
    })) as TripActiveView | undefined;
    return trip ?? null;
  }

  closeTrip(tripId: string): Promise<TripActiveView> {
    return this.http.post(`/trips/${tripId}/close`, {
      body: {},
      schema: closeTripView,
    });
  }

  getTripState(tripId: string): Promise<TripStateView> {
    return this.http.get(`/trips/${tripId}/state`, {schema: tripStateView});
  }

  getTripRoute(tripId: string, leg?: 'pickup'): Promise<TripRoute> {
    // `leg=pickup` pide el tramo de acercamiento vivo (conductor→recojo); sin leg, la canónica.
    return this.http.get(`/trips/${tripId}/route`, {
      ...(leg ? {query: {leg}} : {}),
      schema: tripRoute,
    });
  }

  cancelTrip(tripId: string, input: CancelTripRequest): Promise<TripResource> {
    return this.http.post(`/trips/${tripId}/cancel`, {
      body: input,
      schema: tripResource,
    });
  }

  proposeWaypoint(
    tripId: string,
    point: GeoPoint,
  ): Promise<WaypointProposalView> {
    // El cuerpo SOLO lleva el punto: el passengerId lo estampa el BFF desde el JWT (anti-IDOR) y el
    // server calcula delta de tarifa + ruta + ETA (server-authoritative; el cliente nunca fija precio).
    return this.http.post(`/trips/${tripId}/waypoints`, {
      body: {point},
      schema: waypointProposalView,
    });
  }

  getVideoGrant(tripId: string): Promise<TripVideoGrant> {
    return this.http.get(`/trips/${tripId}/video`, {schema: tripVideoGrant});
  }

  shareTrip(
    tripId: string,
    input: ShareTripRequest = {},
  ): Promise<CreatedShareLink> {
    return this.http.post(`/share/${tripId}`, {
      body: input,
      schema: createdShareLink,
    });
  }

  revokeShare(shareId: string): Promise<RevokedShareLink> {
    // Kill-switch: revoca el enlace de seguimiento de la sesión actual (la página pública deja de
    // servir la ubicación al instante). Idempotente en el server (revocar un revocado = no-op).
    return this.http.post(`/share/${shareId}/revoke`, {
      body: {},
      schema: revokedShareLink,
    });
  }

  listScheduledTrips(): Promise<ScheduledTripList> {
    return this.http.get('/trips/scheduled', {schema: scheduledTripList});
  }

  getTripHistory(query?: TripHistoryQuery): Promise<TripHistoryPage> {
    // El helper del api-client arma `GET /trips/history?cursor=&limit=` y valida con `tripHistoryPage`.
    // El passengerId lo deriva el BFF del JWT (no se manda, anti-IDOR).
    return getTripHistory(this.http, query);
  }

  async cancelScheduledTrip(tripId: string): Promise<void> {
    await this.http.delete<void>(`/trips/${tripId}/schedule`);
  }

  // ── PUJA (ADR 010) ──────────────────────────────────────────────────────────────────────────

  listOffers(tripId: string): Promise<OfferList> {
    return this.http.get(`/trips/${tripId}/offers`, {schema: offerList});
  }

  acceptOffer(tripId: string, driverId: string): Promise<OfferView> {
    return this.http.post(`/trips/${tripId}/offers/${driverId}/accept`, {
      body: {},
      schema: offerView,
    });
  }

  async cancelBid(tripId: string): Promise<void> {
    await this.http.post(`/trips/${tripId}/bid/cancel`, {body: {}});
  }

  rebid(tripId: string, bidCents: number): Promise<TripResource> {
    return this.http.post(`/trips/${tripId}/rebid`, {
      body: {bidCents},
      schema: tripResource,
    });
  }
}
