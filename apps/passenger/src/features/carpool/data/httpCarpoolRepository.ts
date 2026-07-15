import {
  type CarpoolBookingCreateRequest,
  type CarpoolBookingView,
  type CarpoolSearchPage,
  type CarpoolTripDetail,
  carpoolBookingView,
  carpoolSearchPage,
  carpoolTripDetail,
  type HttpClient,
} from '@veo/api-client';
import type {
  CarpoolBrowseParams,
  CarpoolRepository,
  CarpoolSearchParams,
} from '../domain/carpoolRepository';

/**
 * Implementación de `CarpoolRepository` contra el public-bff (`/carpool/*`). Cada respuesta se
 * valida con su schema zod del contrato (`@veo/api-client`), igual que `HttpTripRepository`: si el
 * server cambia el shape, falla acá (ruidoso) y no en un render con datos corruptos.
 */
export class HttpCarpoolRepository implements CarpoolRepository {
  constructor(private readonly http: HttpClient) {}

  browseTrips(params: CarpoolBrowseParams): Promise<CarpoolSearchPage> {
    return this.http.get('/carpool/trips/browse', {
      query: {
        // undefined se omite del query string (lo resuelve el HttpClient), sin ramas acá.
        region: params.region,
        orden: params.orden,
        limit: params.limit,
        cursor: params.cursor,
      },
      schema: carpoolSearchPage,
    });
  }

  searchTrips(params: CarpoolSearchParams): Promise<CarpoolSearchPage> {
    return this.http.get('/carpool/trips/search', {
      query: {
        originLat: params.originLat,
        originLon: params.originLon,
        destLat: params.destLat,
        destLon: params.destLon,
        fecha: params.fecha,
        asientos: params.asientos,
        // undefined se omite del query string (lo resuelve el HttpClient), sin ramas acá.
        orden: params.orden,
        precioMaxCents: params.precioMaxCents,
        salidaDesde: params.salidaDesde,
        salidaHasta: params.salidaHasta,
        limit: params.limit,
        cursor: params.cursor,
      },
      schema: carpoolSearchPage,
    });
  }

  getTripDetail(tripId: string): Promise<CarpoolTripDetail> {
    return this.http.get(`/carpool/trips/${tripId}`, {
      schema: carpoolTripDetail,
    });
  }

  reserve(
    request: CarpoolBookingCreateRequest,
    idempotencyKey: string,
  ): Promise<CarpoolBookingView> {
    // IK · UUID por submit: el reintento del MISMO submit dedupea server-side (booking-service);
    // un submit nuevo (otra reserva) lleva key nueva y NO queda bloqueado.
    return this.http.post('/carpool/bookings', {
      body: request,
      schema: carpoolBookingView,
      idempotencyKey,
    });
  }

  getBooking(bookingId: string): Promise<CarpoolBookingView> {
    return this.http.get(`/carpool/bookings/${bookingId}`, {
      schema: carpoolBookingView,
    });
  }

  cancel(bookingId: string): Promise<CarpoolBookingView> {
    // POST sin body: el server toma el passengerId de la sesión (anti-IDOR) y sella ownership + estado.
    // Devuelve la reserva ya en CANCELADO, validada con el mismo schema del contrato.
    return this.http.post(`/carpool/bookings/${bookingId}/cancel`, {
      schema: carpoolBookingView,
    });
  }
}
