import type { HttpClient } from '@veo/api-client';
import {
  bookingRequestList,
  bookingRequestView,
  publishTripRequest,
  publishedTripList,
  publishedTripView,
  updateTripRequest,
} from '@veo/api-client';
import type {
  BookingRequest,
  BookingRequests,
  CarpoolRepository,
  PublishTripInput,
  PublishedTrip,
  PublishedTrips,
  UpdateTripInput,
} from '../../domain';

/** Implementación HTTP del `CarpoolRepository` contra el driver-bff (`/carpool/*` · ADR-014). */
export class HttpCarpoolRepository implements CarpoolRepository {
  constructor(private readonly http: HttpClient) {}

  getMyTrips(): Promise<PublishedTrips> {
    return this.http.get('/carpool/trips', { schema: publishedTripList });
  }

  publishTrip(input: PublishTripInput): Promise<PublishedTrip> {
    // Valida el body con el contrato antes de enviarlo (strip de campos no permitidos). El `driverId`
    // NO viaja: lo deriva el driver-bff de la identidad firmada.
    const body = publishTripRequest.parse(input);
    return this.http.post('/carpool/trips', { body, schema: publishedTripView });
  }

  updateTrip(tripId: string, input: UpdateTripInput): Promise<PublishedTrip> {
    // Patch PARCIAL: el contrato deja todos los campos opcionales; parseamos para strip + tipado.
    const body = updateTripRequest.parse(input);
    return this.http.patch(`/carpool/trips/${tripId}`, { body, schema: publishedTripView });
  }

  cancelTrip(tripId: string): Promise<PublishedTrip> {
    return this.http.post(`/carpool/trips/${tripId}/cancel`, { schema: publishedTripView });
  }

  getTripBookings(tripId: string): Promise<BookingRequests> {
    return this.http.get(`/carpool/trips/${tripId}/bookings`, { schema: bookingRequestList });
  }

  approveBooking(bookingId: string): Promise<BookingRequest> {
    return this.http.post(`/carpool/bookings/${bookingId}/approve`, { schema: bookingRequestView });
  }

  rejectBooking(bookingId: string): Promise<BookingRequest> {
    return this.http.post(`/carpool/bookings/${bookingId}/reject`, { schema: bookingRequestView });
  }
}
