import type {
  CancelTripRequest,
  CreateTripRequest,
  CreatedShareLink,
  GeoPoint,
  OfferList,
  OfferView,
  ScheduledTripList,
  ShareTripRequest,
  SurgeQuote,
  TripActiveView,
  TripHistoryPage,
  TripHistoryQuery,
  TripResource,
  TripStateView,
  TripVideoGrant,
  WaypointProposalView,
} from '@veo/api-client';

/**
 * Abstracción del repositorio de Viajes (DIP). Cubre cotización, creación, vista activa,
 * cancelación, cambio de destino y autorización de video del habitáculo.
 */
export interface TripRepository {
  /** GET /dispatch/surge?lat&lon → multiplicador dinámico para estimar tarifa. */
  getSurge(coords: GeoPoint): Promise<SurgeQuote>;
  /**
   * POST /trips → crea/cotiza el viaje (devuelve la cotización firme).
   * IK · `idempotencyKey` viaja como cabecera Idempotency-Key: un reintento (red flaky / doble-submit)
   * con la MISMA key devuelve el MISMO viaje en vez de crear dos boards (y cobrar dos veces).
   */
  createTrip(input: CreateTripRequest, idempotencyKey?: string): Promise<TripResource>;
  /** GET /trips/:id → vista agregada del viaje activo (estado + conductor + vehículo). */
  getActiveTrip(tripId: string): Promise<TripActiveView>;
  /**
   * GET /trips/active → viaje VIVO del pasajero SIN conocer su id, o `null` si no tiene ninguno (204).
   * Fuente de verdad para REHIDRATAR el flujo unificado al (re)entrar y para el banner cross-tab.
   */
  getMyActiveTrip(): Promise<TripActiveView | null>;
  /**
   * GET /trips/pending-settlement → cierre post-viaje PENDIENTE del pasajero (último COMPLETED sin
   * cerrar), o `null` (204) si no hay ninguno. Re-entrada del cierre tras un reload: COMPLETED es
   * terminal y `GET /trips/active` ya no lo devuelve, así que el cierre (recibo + efectivo + rating)
   * se re-ofrece desde acá. Mismo shape agregado que la vista activa.
   */
  getPendingSettlement(): Promise<TripActiveView | null>;
  /**
   * POST /trips/:id/close → cierra el post-viaje de un viaje COMPLETED (IDEMPOTENTE). `passengerClosedAt`
   * es un flag de UX (no cambia el estado): tras esto el viaje deja de aparecer en pending-settlement.
   */
  closeTrip(tripId: string): Promise<TripActiveView>;
  /** GET /trips/:id/state → estado ligero (polling de respaldo del socket). */
  getTripState(tripId: string): Promise<TripStateView>;
  /** POST /trips/:id/cancel → cancela el viaje. */
  cancelTrip(tripId: string, input: CancelTripRequest): Promise<TripResource>;
  /** POST /trips/:id/destination → cambia el destino en curso. */
  changeDestination(tripId: string, destination: GeoPoint): Promise<TripResource>;
  /**
   * POST /trips/:id/waypoints → PROPONE una parada intermedia durante el viaje EN CURSO (Lote C2/C3).
   * El cuerpo solo transporta el punto; el server calcula el delta de tarifa, la ruta y el ETA nuevos
   * (server-authoritative). Devuelve la propuesta (id + delta + tarifa/ETA nuevos + vencimiento) que el
   * pasajero confirma visualmente mientras espera la respuesta del conductor.
   */
  proposeWaypoint(tripId: string, point: GeoPoint): Promise<WaypointProposalView>;
  /** GET /trips/:id/video → token viewer LiveKit del habitáculo (puede degradar a "sin video"). */
  getVideoGrant(tripId: string): Promise<TripVideoGrant>;
  /** POST /share/:tripId → crea un enlace público firmado de seguimiento del viaje en curso. */
  shareTrip(tripId: string, input?: ShareTripRequest): Promise<CreatedShareLink>;
  /** GET /trips/scheduled → viajes PROGRAMADOS (estado SCHEDULED) del pasajero, ordenados por hora. */
  listScheduledTrips(): Promise<ScheduledTripList>;
  /**
   * GET /trips/history → una PÁGINA del historial REAL del pasajero (estados COMPLETED/CANCELLED/
   * EXPIRED/FAILED…), ordenado por `requestedAt` DESC y paginado por CURSOR (keyset, no offset). El
   * `passengerId` lo deriva el BFF del JWT (anti-IDOR). El `nextCursor` es OPACO: la app lo re-pasa
   * tal cual hasta que llega `null` (no hay más). ESTA es la fuente de verdad del historial — NO el
   * snapshot MMKV (que solo cachea recents + la polyline del detalle).
   */
  getTripHistory(query?: TripHistoryQuery): Promise<TripHistoryPage>;
  /** DELETE /trips/:id/schedule → cancela un viaje programado (sin penalidad si es con antelación). */
  cancelScheduledTrip(tripId: string): Promise<void>;

  // ── PUJA (ADR 010) · negociación del board del pasajero ──────────────────────────────────────
  /** GET /trips/:id/offers → ofertas del board (conductores que aceptaron/contraofertaron). */
  listOffers(tripId: string): Promise<OfferList>;
  /** POST /trips/:id/offers/:driverId/accept → el pasajero elige UNA oferta (por `driverId`). */
  acceptOffer(tripId: string, driverId: string): Promise<OfferView>;
  /** POST /trips/:id/bid/cancel → el pasajero cancela su puja (idempotente). */
  cancelBid(tripId: string): Promise<void>;
  /** POST /trips/:id/rebid → re-abre el board con una nueva tarifa (desde EXPIRED/REASSIGNING). */
  rebid(tripId: string, bidCents: number): Promise<TripResource>;
}
