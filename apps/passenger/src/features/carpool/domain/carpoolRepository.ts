import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolPopularRoutes,
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
  /**
   * Orden del marketplace (pen P/ProgResults · chips): `salida` (más temprana primero, el default
   * del server) o `precio` (más barato primero). El keyset del server es sort-aware: cambiar el
   * orden invalida el cursor (la UI re-consulta desde la página 1 al cambiarlo).
   */
  orden?: 'salida' | 'precio';
  /** Filtro: precio máximo por asiento, en céntimos (`precioAsientoCents <= valor`). */
  precioMaxCents?: number;
  /** Filtro: hora mínima de salida dentro del día, `HH:mm` hora Lima (franja del chip "Salida"). */
  salidaDesde?: string;
  /** Filtro: hora máxima de salida dentro del día, `HH:mm` hora Lima (inclusiva al minuto). */
  salidaHasta?: string;
  /** Tamaño de página (keyset). */
  limit?: number;
  /** Cursor opaco de la página anterior (`nextCursor`); undefined = primera página. */
  cursor?: string;
}

/**
 * Parámetros del FEED del marketplace (browse-first, tab Compartir): TODOS los viajes publicados
 * futuros, sin ruta requerida. `region` filtra por bounding box del catálogo compartido
 * (`REGIONS_PE` de @veo/utils); ausente = todas las regiones.
 */
export interface CarpoolBrowseParams {
  /** Id del catálogo de regiones (`lima-metropolitana`, `ancash`, …); undefined = todas. */
  region?: string;
  /** Región de DESTINO (mismo catálogo): filtra por bbox del destino (rutas populares). */
  destRegion?: string;
  /** Orden del feed (`salida` default | `precio`). */
  orden?: 'salida' | 'precio';
  /** Tamaño de página (keyset). */
  limit?: number;
  /** Cursor opaco de la página anterior; undefined = primera página. */
  cursor?: string;
}

/**
 * Puerto del marketplace de carpooling para el PASAJERO (public-bff `/carpool/*`). Browsear el
 * feed, buscar viajes publicados, ver el detalle enriquecido, solicitar la reserva y seguir el
 * estado de la solicitud. El `passengerId` NUNCA viaja en los cuerpos: lo deriva el BFF de la
 * sesión (anti-IDOR).
 */
export interface CarpoolRepository {
  /** GET /carpool/trips/browse — FEED keyset de TODOS los viajes futuros (filtro región opcional). */
  browseTrips(params: CarpoolBrowseParams): Promise<CarpoolSearchPage>;

  /** GET /carpool/trips/popular-routes — top de pares región→región con oferta viva (count + desde). */
  getPopularRoutes(): Promise<CarpoolPopularRoutes>;

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
