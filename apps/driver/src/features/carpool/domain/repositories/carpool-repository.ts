import type {
  BookingRequest,
  BookingRequests,
  PublishTripInput,
  PublishedTrip,
  PublishedTrips,
  UpdateTripInput,
} from '../entities';

/**
 * Contrato del repositorio de carpooling del CONDUCTOR (capa domain · ADR-014). Implementación
 * concreta en `data/` contra el driver-bff (`/carpool/*`). El `driverId` NUNCA viaja en el body/URL:
 * lo deriva el BFF de la identidad firmada (server-truth, anti-IDOR).
 */
export interface CarpoolRepository {
  /** GET /carpool/trips — mis ofertas publicadas (scoped al conductor autenticado). */
  getMyTrips(): Promise<PublishedTrips>;
  /** POST /carpool/trips — publicar una nueva oferta. */
  publishTrip(input: PublishTripInput): Promise<PublishedTrip>;
  /** PATCH /carpool/trips/:id — editar una oferta PUBLICADA (patch parcial). */
  updateTrip(tripId: string, input: UpdateTripInput): Promise<PublishedTrip>;
  /** POST /carpool/trips/:id/cancel — cancelar una de mis ofertas. */
  cancelTrip(tripId: string): Promise<PublishedTrip>;
  /** GET /carpool/trips/:id/bookings — solicitudes entrantes de un viaje PROPIO. */
  getTripBookings(tripId: string): Promise<BookingRequests>;
  /** POST /carpool/bookings/:id/approve — aprobar una solicitud. */
  approveBooking(bookingId: string): Promise<BookingRequest>;
  /** POST /carpool/bookings/:id/reject — rechazar una solicitud. */
  rejectBooking(bookingId: string): Promise<BookingRequest>;
}
