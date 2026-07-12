import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';

/**
 * Parámetros de la BÚSQUEDA de viajes publicados (marketplace de carpooling · ADR-014, lado
 * pasajero). Coordenadas en grados decimales; `fecha` es un DÍA calendario (YYYY-MM-DD, local del
 * pasajero) — el carpooling intercity se busca por día, no por hora exacta.
 */
export interface CarpoolSearchParams {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  /** Día calendario buscado, formato YYYY-MM-DD. */
  fecha: string;
  /** Asientos que el pasajero necesita (1..8). */
  asientos: number;
  /** Tamaño de página (keyset). */
  limit?: number;
  /** Cursor opaco de la página anterior (`nextCursor`); undefined = primera página. */
  cursor?: string;
}

/**
 * Puerto del marketplace de carpooling para el PASAJERO (public-bff `/carpool/*`). Buscar viajes
 * publicados, ver el detalle enriquecido, solicitar la reserva y seguir el estado de la solicitud.
 * El `passengerId` NUNCA viaja en los cuerpos: lo deriva el BFF de la sesión (anti-IDOR).
 */
export interface CarpoolRepository {
  /** GET /carpool/trips/search — página keyset de viajes que calzan ruta + fecha + asientos. */
  searchTrips(params: CarpoolSearchParams): Promise<CarpoolSearchPage>;

  /** GET /carpool/trips/:id — detalle enriquecido (driver/vehicle nullable: degradación honesta). */
  getTripDetail(tripId: string): Promise<CarpoolTripDetail>;

  /**
   * POST /carpool/bookings — solicita la reserva. `idempotencyKey` (UUID por submit) deduplica el
   * REINTENTO del mismo submit server-side sin bloquear una reserva nueva.
   */
  reserve(
    request: CarpoolBookingCreateRequest,
    idempotencyKey: string,
  ): Promise<CarpoolBookingView>;

  /** GET /carpool/bookings/:id — MI reserva (seguimiento del estado; ajena → 404 server-side). */
  getBooking(bookingId: string): Promise<CarpoolBookingView>;

  /**
   * POST /carpool/bookings/:id/cancel — cancela MI solicitud aún PENDIENTE (sin body). El server sella
   * ownership + estado (solo PENDIENTE_APROBACION): ajena/inexistente → 404, ya resuelta → 409. Devuelve la
   * reserva ya en CANCELADO. Sin cobro ni refund (charge-on-approval: nunca se aprobó).
   */
  cancel(bookingId: string): Promise<CarpoolBookingView>;
}
