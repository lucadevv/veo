/**
 * Dominio de viajes del pasajero. Lecturas vía gRPC (con agregación trip+conductor+rating+vehículo),
 * comandos vía REST interno firmado. El passengerId/actor se derivan SIEMPRE de la identidad
 * autenticada, nunca del cliente.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { DriverEnrichmentService } from './driver-enrichment.service';
import { DispatchService } from '../dispatch/dispatch.service';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { ForbiddenError, NotFoundError, uuidv7 } from '@veo/utils';
import {
  canAccessLiveCabin,
  normalizeTripStatus,
  type TripVideoGrant,
  type WaypointProposalView,
} from '@veo/api-client';
import {
  GRPC_FLEET,
  GRPC_IDENTITY,
  GRPC_PAYMENT,
  GRPC_RATING,
  GRPC_TRIP,
  LIVEKIT,
  REST_DISPATCH,
  REST_PAYMENT,
  REST_RATING,
  REST_TRIP,
} from '../infra/downstream.tokens';
import Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import type {
  AggregateReply,
  DriverReply,
  DriverTripStatsReply,
  DriverVehiclesReply,
  PassengerTripsReply,
  PaymentReply,
  TripReply,
  TripStateReply,
  VehicleReply,
} from '../infra/grpc-types';
import { DebtPendingError, type PaymentView } from '../payments/dto/payments.dto';
import type { DebtSummaryReply } from '../payments/payments.types';
import {
  type LiveKitConfig,
  liveKitEnabled,
  liveKitRoomForTrip,
  mintViewerToken,
} from '../share/livekit-token';
import {
  buildTripDetail,
  buildTripHistoryPage,
  buildTripState,
  type TripDetailView,
  type TripHistoryPageView,
  type TripStateView,
} from './trip-views';
import {
  type CancelTripDto,
  type ChangeDestinationDto,
  type CreateTripDto,
  type RebidTripDto,
  type TripResource,
} from './dto/trip.dto';
import { type OfferView, type OffersResponse } from './dto/offers.dto';

/** TTL del cache del resultado SIN deuda (positivo del gate de deuda). Corto: acota una deuda recién creada. */
const NO_DEBT_CACHE_TTL_SECONDS = 60;

@Injectable()
export class TripsService {
  constructor(
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_RATING) private readonly ratingGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
    @Inject(GRPC_PAYMENT) private readonly paymentGrpc: GrpcServiceClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    @Inject(REST_DISPATCH) private readonly dispatchRest: InternalRestClient,
    @Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient,
    @Inject(REST_RATING) private readonly ratingRest: InternalRestClient,
    @Inject(LIVEKIT) private readonly livekit: LiveKitConfig,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly enrichment: DriverEnrichmentService,
    private readonly dispatch: DispatchService,
  ) {}

  private readonly logger = new Logger(TripsService.name);

  /** Crea un viaje. Idempotente: usa la Idempotency-Key del cliente o genera una UUIDv7. */
  async createTrip(
    user: AuthenticatedUser,
    dto: CreateTripDto,
    idempotencyKey?: string,
  ): Promise<TripResource> {
    // ADR-018: el KYC del pasajero dejó de ser un muro pre-viaje. Un pasajero UNVERIFIED PUEDE pedir; la
    // verificación es OPCIONAL (badge de confianza), se ofrece desde Perfil, no gatea la creación del viaje.
    // Gate de deuda (BR-P02): un pasajero con un cobro en DEBT NO puede pedir un viaje nuevo (decisión
    // de producto: la deuda bloquea TODO pedido). Server-side. 403 DEBT_PENDING con el detalle para el
    // banner. Cacheado SOLO el resultado sin deuda (positivo).
    await this.assertNoDebt(user);
    // ADR-021 Fase C (C1) — el surge es AUTORITATIVO server-side, NUNCA se confía del cliente. Un cliente
    // modificado podía mandar `surgeMultiplier=1.0` para esquivar el surge (sub-cobro) o un valor arbitrario.
    // Lo RE-COTIZAMOS acá (trust boundary del BFF) contra dispatch con el ORIGIN del viaje y forwardeamos ESE
    // valor; `dto.surgeMultiplier` queda display-only (lo que el pasajero vio en la cotización, no autoritativo).
    // Solo aplica a la TARIFA FIJA: en PUJA (`bidCents` presente) el bid ES el precio → surge irrelevante, se
    // omite. Fail-safe: si dispatch no responde, degradamos a 1.0 (sin surge) — jamás confiamos el valor del
    // cliente ni sobre-cobramos. (Follow-up ADR-021: un viaje PROGRAMADO debería re-cotizar surge en la
    // activación, no en la creación — acá igual queda autoritativo, no tampereable.)
    const surgeMultiplier =
      dto.bidCents == null
        ? await this.dispatch
            .getSurge(user, dto.origin.lat, dto.origin.lon)
            .then((s) => s.multiplier)
            .catch((err: unknown) => {
              this.logger.warn(
                `surge no disponible al crear viaje (degradado a 1.0): ${String(err)}`,
              );
              return 1.0;
            })
        : undefined;
    return this.tripRest.post<TripResource>('/trips', {
      identity: user,
      idempotencyKey: idempotencyKey ?? uuidv7(),
      body: {
        passengerId: user.userId,
        origin: dto.origin,
        destination: dto.destination,
        // Ola 2B: paradas múltiples, hora programada y tipo de vehículo (moto-taxi).
        waypoints: dto.waypoints,
        scheduledFor: dto.scheduledFor,
        vehicleType: dto.vehicleType,
        // PUJA (ADR 010): si el pasajero propone su precio, trip-service ramifica a la puja (abre el
        // board); si se omite, queda undefined y trip-service usa el camino de tarifa fija (BR-T05).
        bidCents: dto.bidCents,
        paymentMethod: dto.paymentMethod,
        category: dto.category,
        // Autoritativo (Fase C): el surge re-cotizado server-side, NO el `dto.surgeMultiplier` del cliente.
        surgeMultiplier,
        childMode: dto.childMode,
        childCode: dto.childCode,
        // Ola 2A: el código de promo viaja a trip-service, se persiste y se propaga al cobro.
        promoCode: dto.promoCode,
        // BE-2: solicitudes especiales (mascota/equipaje/silla); el conductor las ve antes de aceptar.
        specialRequests: dto.specialRequests,
      },
    });
  }

  /**
   * Gate de deuda (BR-P02): lanza DebtPendingError (403) si el pasajero tiene un cobro en DEBT.
   * Cachea SOLO el resultado SIN deuda (positivo) en Redis con TTL corto (60s), para no pegarle a
   * payment en CADA pedido (hot-path). CON deuda NUNCA se cachea: un pasajero que recién saldó debe
   * poder pedir al instante, y uno que recién contrajo deuda queda bloqueado sin esperar a un TTL. Si
   * Redis está caído, se consulta la fuente autoritativa (payment) — nunca hace bypass del gate.
   */
  private async assertNoDebt(user: AuthenticatedUser): Promise<void> {
    const cacheKey = `debt:none:${user.userId}`;
    try {
      if ((await this.redis.get(cacheKey)) === '1') {
        return;
      }
    } catch {
      // Redis no disponible: caemos a la consulta autoritativa (no bypass).
    }
    const summary = await this.paymentRest.get<DebtSummaryReply>('/payments/debt', {
      identity: user,
    });
    // El gate SOLO bloquea por DEUDA real (kind=DEBT). `hasDebt`/`totalCents` ya resumen solo los DEBT;
    // un PENDING_ACTION (pago por completar) viaja en `debts` pero NO debe bloquear ni contar (un pago
    // a medio completar no es una deuda). Defensa en profundidad: derivamos el oldestTripId del primer
    // DEBT explícitamente (no del primer item, que podría ser un PENDING_ACTION si el orden cambiara).
    if (summary.hasDebt) {
      // CON deuda: NUNCA cachear. Bloqueo inmediato con el detalle para el banner de la app.
      // BLOQUEAN tanto DEBT como CANCELLATION_PENALTY; solo PENDING_ACTION (pago por completar) NO.
      // Derivamos el oldestTripId del primer ítem BLOQUEANTE (no del primer item, que podría ser un
      // PENDING_ACTION si el orden cambiara) para que el banner haga deep-link al viaje ofensor —
      // incluido el caso de bloqueo SOLO por penalidad, donde no hay ningún DEBT.
      const blocking = summary.debts.filter((d) => (d.kind ?? 'DEBT') !== 'PENDING_ACTION');
      const oldestTripId = blocking[0]?.tripId ?? null;
      throw new DebtPendingError(summary.totalCents, oldestTripId);
    }
    try {
      await this.redis.set(cacheKey, '1', 'EX', NO_DEBT_CACHE_TTL_SECONDS);
    } catch {
      // best-effort: si no se pudo cachear, el próximo pedido reconsulta.
    }
  }

  /** Lista los viajes PROGRAMADOS (no activados) del pasajero autenticado (Ola 2B). */
  listScheduled(user: AuthenticatedUser): Promise<TripResource[]> {
    return this.tripRest.get<TripResource[]>('/trips/scheduled', {
      identity: user,
      query: { passengerId: user.userId },
    });
  }

  /**
   * Historial REAL del pasajero autenticado (servidor, no la lista local MMKV de la app): SUS viajes
   * ordenados por requestedAt DESC, paginados por cursor. Trae los ESTADOS REALES (COMPLETED /
   * CANCELLED / EXPIRED) que la foto local de la app no tiene; ALIMENTA el detalle (GetTrip) con esos
   * estados, no lo reemplaza.
   *
   * ANTI-IDOR BY CONSTRUCTION: el passengerId se deriva SIEMPRE del JWT (user.userId) y se manda al gRPC;
   * NUNCA del query. Un curl no puede pedir el historial de otro pasajero: el `where` server-side filtra
   * por ESE passengerId, así que la lista solo puede contener viajes propios.
   *
   * ANTI-N+1: la lista NO resuelve el nombre del conductor (sería 1 gRPC a identity por item). La card
   * muestra tier+ruta+monto+estado con SOLO el driverId; el nombre lo resuelve el DETALLE on-demand.
   */
  async getTripHistory(
    user: AuthenticatedUser,
    cursor?: string,
    limit?: number,
  ): Promise<TripHistoryPageView> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const page = await this.tripGrpc.call<PassengerTripsReply>(
      'ListPassengerTrips',
      // passengerId del JWT, NUNCA del query (anti-IDOR). El limit lo CLAMPea trip-service.
      { passengerId: user.userId, cursor: cursor ?? '', limit: limit ?? 0 },
      meta,
    );
    return buildTripHistoryPage(page);
  }

  /**
   * Cancela un viaje PROGRAMADO del pasajero antes de su activación (Ola 2B; sin penalidad).
   * El passengerId se fija desde la identidad autenticada (trip-service verifica la pertenencia).
   */
  cancelSchedule(user: AuthenticatedUser, tripId: string): Promise<TripResource> {
    return this.tripRest.delete<TripResource>(`/trips/${tripId}/schedule`, {
      identity: user,
      body: { passengerId: user.userId },
    });
  }

  /** Detalle agregado del viaje: trip + conductor (identity) + rating + vehículo (fleet). */
  async getTripDetail(user: AuthenticatedUser, tripId: string): Promise<TripDetailView> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero');
    }
    return this.enrichTripDetail(user, trip, meta);
  }

  /**
   * Viaje ACTIVO (vivo) del pasajero autenticado, o null si no tiene ninguno. Es la fuente de verdad
   * para la RE-ENTRADA al flujo unificado (rehidrata el sheet al estado real) y para el banner
   * cross-tab. El passengerId se deriva SIEMPRE de la identidad (nunca del cliente); "vivo" lo decide
   * trip-service (LIVE_STATES). Sin viaje activo NO es error: devolvemos null (la app muestra el home).
   */
  async getActiveTrip(user: AuthenticatedUser): Promise<TripDetailView | null> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>(
      'GetActiveTrip',
      { passengerId: user.userId },
      meta,
    );
    if (!trip.found) return null;
    return this.enrichTripDetail(user, trip, meta);
  }

  /**
   * Pending settlement (re-entrada del cierre): el ÚLTIMO viaje COMPLETED del pasajero sin cerrar, o
   * null si no tiene ninguno. Es la fuente de verdad para RE-OFRECER el cierre post-viaje (recibo +
   * confirmar efectivo + rating) tras un reload: COMPLETED es terminal y GetActiveTrip ya no lo devuelve.
   * El passengerId se deriva SIEMPRE de la identidad (nunca del cliente). Se enriquece IGUAL que la vista
   * activa (conductor/vehículo/rating, best-effort). Sin pendiente NO es error: devolvemos null (204).
   */
  async getPendingSettlement(user: AuthenticatedUser): Promise<TripDetailView | null> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>(
      'GetPendingSettlementTrip',
      { passengerId: user.userId },
      meta,
    );
    if (!trip.found) return null;
    return this.enrichTripDetail(user, trip, meta);
  }

  /**
   * Cierre post-viaje por el pasajero (re-entrada): sella el cierre sobre SU viaje COMPLETED. Idempotente
   * (cerrar dos veces es ok). Mismo gate anti-IDOR que las otras operaciones (assertOwnsTrip → 404/403)
   * ANTES de delegar al gRPC, que re-valida ownership server-side (defensa en profundidad). El passengerId
   * se fija desde la identidad autenticada (user.userId), nunca del cliente. NO toca la máquina de estados.
   */
  async close(user: AuthenticatedUser, tripId: string): Promise<TripDetailView> {
    await this.assertOwnsTrip(user, tripId);
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>(
      'CloseTripByPassenger',
      { id: tripId, passengerId: user.userId },
      meta,
    );
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    return this.enrichTripDetail(user, trip, meta);
  }

  /**
   * Enriquecimiento NO esencial (conductor/vehículo/rating): best-effort. Si un downstream está caído o
   * lento, el detalle del viaje NO se rompe — se omite ese campo (degradación grácil, mismo patrón que
   * DriverEnrichmentService.fetchInfo). El core (GetTrip/GetActiveTrip) sí es esencial. Sin esto, tener
   * rating-service abajo tiraba 500 en cuanto se asignaba conductor. Compartido por detalle y activo.
   */
  private async enrichTripDetail(
    user: AuthenticatedUser,
    trip: TripReply,
    meta: ReturnType<typeof grpcIdentityMetadata>,
  ): Promise<TripDetailView> {
    // El conductor se resuelve PRIMERO (no en el Promise.all): el fallback de vehículo por conductor
    // necesita su `userId` (fleet indexa por User.id, no por Driver.id — ver resolveTripVehicle). 1 ida
    // extra solo en el detalle (no es hot-path). Best-effort: si identity cae, driver=null y se degrada.
    const driver = trip.driverId
      ? await this.identityGrpc
          .call<DriverReply>('GetDriver', { id: trip.driverId }, meta)
          .catch(() => null)
      : null;
    const [vehicle, aggregate, myRating, tipCents, tripStats] = await Promise.all([
      this.resolveTripVehicle(trip, driver?.found ? driver.userId : undefined, meta),
      trip.driverId
        ? this.ratingGrpc
            .call<AggregateReply>('GetAggregate', { subjectId: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      // MI rating de este viaje (REST firmado, filtrado por el rater = identidad). 404 (sin rating) → null;
      // cualquier otro fallo también → null (degradación grácil: la app cae al GET /ratings?tripId on-demand).
      this.fetchMyRatingStars(user, trip.id),
      // A1 · propina TOTAL cobrada del viaje (recibo de payment; agrega los tip-Payments digitales de Model B).
      // Así el detalle/app sabe que ya se dio propina y no habilita re-propinar al re-montar. Best-effort → 0.
      this.fetchTripTipCents(trip.id, meta),
      // Conteo de viajes COMPLETED del conductor (señal de confianza "N viajes"); best-effort → null (degradación honesta).
      trip.driverId
        ? this.tripGrpc
            .call<DriverTripStatsReply>('GetDriverTripStats', { driverId: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    return buildTripDetail(
      trip,
      driver?.found ? driver : null,
      aggregate?.found ? aggregate : null,
      vehicle,
      tipCents,
      myRating,
      tripStats,
    );
  }

  /** Propina TOTAL cobrada del viaje (recibo de payment, best-effort). 0 si no hay pago o payment-service cae. */
  private async fetchTripTipCents(
    tripId: string,
    meta: ReturnType<typeof grpcIdentityMetadata>,
  ): Promise<number> {
    try {
      const p = await this.paymentGrpc.call<PaymentReply>('GetPaymentByTrip', { tripId }, meta);
      return p.found ? p.tipCents : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Resuelve el vehículo del viaje (SEGURIDAD: placa/modelo/color para confirmar el auto). Best-effort:
   *  1) Si el viaje tiene `vehicleId` persistido (asignación nueva) → ESE vehículo exacto por id (histórico
   *     fiel, sin ambigüedad de ids).
   *  2) Si no (viajes previos a la persistencia) → el vehículo ACTIVO del conductor. fleet indexa por
   *     `User.id` (NO por Driver.id), así que el fallback usa el `userId` ya resuelto vía identity. Para
   *     un viaje EN CURSO es el auto correcto; para uno viejo, el auto actual del conductor (honesto).
   *     Si fleet cae o no hay vehículo → null (el detalle no se rompe).
   */
  private async resolveTripVehicle(
    trip: TripReply,
    driverUserId: string | undefined,
    meta: ReturnType<typeof grpcIdentityMetadata>,
  ): Promise<VehicleReply | null> {
    if (trip.vehicleId) {
      const v = await this.fleetGrpc
        .call<VehicleReply>('GetVehicle', { id: trip.vehicleId }, meta)
        .catch(() => null);
      return v?.found ? v : null;
    }
    if (!driverUserId) return null;
    const reply = await this.fleetGrpc
      .call<DriverVehiclesReply>('GetDriverVehicles', { id: driverUserId }, meta)
      .catch(() => null);
    return reply?.vehicles?.find((v) => v.active) ?? reply?.vehicles?.[0] ?? null;
  }

  /** Estrellas de MI rating de un viaje (REST firmado, rater=identidad), o null. Nunca lanza (best-effort). */
  private async fetchMyRatingStars(
    user: AuthenticatedUser,
    tripId: string,
  ): Promise<number | null> {
    try {
      const r = await this.ratingRest.get<{ stars: number }>('/ratings', {
        identity: user,
        query: { tripId },
      });
      return r.stars;
    } catch {
      // 404 (sin rating) o cualquier fallo del downstream → null. No rompemos el detalle del viaje.
      return null;
    }
  }

  /**
   * Estado del viaje (polling ligero) vía gRPC.
   * TripStateReply NO incluye passengerId, así que la pertenencia se verifica con un GetTrip previo
   * (mismo patrón que videoGrant/tip) para evitar IDOR: un pasajero no puede leer el estado de un
   * viaje ajeno por id.
   */
  async getTripState(user: AuthenticatedUser, tripId: string): Promise<TripStateView> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero');
    }
    const state = await this.tripGrpc.call<TripStateReply>('GetTripState', { id: tripId }, meta);
    if (!state.found) throw new NotFoundError('Viaje no encontrado');
    return buildTripState(state);
  }

  /**
   * Token de video del habitáculo (LiveKit self-hosted) para el pasajero en SU viaje en curso.
   * - Si LiveKit no está configurado → 404 (la app degrada a "sin video").
   * - Solo autoriza si el viaje es del pasajero autenticado y está IN_PROGRESS.
   * Devuelve un token viewer (solo suscripción) firmado para la sala `trip-<tripId>` (donde publica el conductor).
   */
  async videoGrant(user: AuthenticatedUser, tripId: string): Promise<TripVideoGrant> {
    if (!liveKitEnabled(this.livekit)) {
      throw new NotFoundError('El video del habitáculo no está disponible');
    }
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero');
    }
    // Status crudo del gRPC → contrato; fuera del contrato (null) = fail-closed. La política
    // (solo viaje en curso) vive en el predicado de dominio compartido por los 3 BFFs.
    const status = normalizeTripStatus(trip.status);
    if (status === null || !canAccessLiveCabin(status)) {
      throw new ForbiddenError('La cámara solo está disponible durante el viaje en curso');
    }
    const room = liveKitRoomForTrip(tripId);
    const minted = mintViewerToken(this.livekit, {
      room,
      identityPrefix: `passenger-${user.userId}`,
    });
    return { url: this.livekit.url, token: minted.token, roomName: room };
  }

  /** Cancelación por el pasajero (el actor se fija a PASSENGER). */
  async cancel(user: AuthenticatedUser, tripId: string, dto: CancelTripDto): Promise<TripResource> {
    // A1 · anti-IDOR: verificar ownership ANTES de delegar (igual que las hermanas de PUJA). Sin esto, un
    // curl con el JWT de A cancelaba el viaje de B (+penalización). `passengerId` = 2da capa en trip-service.
    await this.assertOwnsTrip(user, tripId);
    return this.tripRest.post<TripResource>(`/trips/${tripId}/cancel`, {
      identity: user,
      body: { by: 'PASSENGER', reason: dto.reason, passengerId: user.userId },
    });
  }

  /** Cambio de destino aprobado por el pasajero (recalcula tarifa downstream). */
  async changeDestination(
    user: AuthenticatedUser,
    tripId: string,
    dto: ChangeDestinationDto,
  ): Promise<TripResource> {
    // A1 · anti-IDOR: solo el dueño reescribe el destino de SU viaje (gate primario; trip-service re-valida).
    await this.assertOwnsTrip(user, tripId);
    return this.tripRest.post<TripResource>(`/trips/${tripId}/destination`, {
      identity: user,
      body: { destination: dto.destination, passengerId: user.userId },
    });
  }

  /**
   * Lote C2 · el PASAJERO propone una parada DURANTE el viaje (IN_PROGRESS). Mismo gate anti-IDOR que
   * changeDestination (assertOwnsTrip → solo el dueño propone sobre SU viaje; trip-service re-valida
   * server-side). El passengerId lo estampa trip-service desde la identidad FIRMADA (no del cliente). El
   * delta de tarifa + ruta nueva los calcula el server (server-authoritative): el BFF solo proxya y
   * devuelve la propuesta. Los 409 del downstream (parada activa / viaje no en curso / cupo) se propagan tal cual.
   */
  async proposeWaypoint(
    user: AuthenticatedUser,
    tripId: string,
    point: { lat: number; lon: number },
  ): Promise<WaypointProposalView> {
    await this.assertOwnsTrip(user, tripId);
    return this.tripRest.post<WaypointProposalView>(`/trips/${tripId}/waypoints`, {
      identity: user,
      body: { point },
    });
  }

  /**
   * Propina del pasajero a SU viaje ya cobrado (BR-P04). 100% al conductor, fuera de comisión.
   * Verifica que el viaje pertenece al pasajero autenticado (gRPC GetTrip) antes de delegar al
   * payment-service por REST interno firmado. La dedupKey se deriva del passenger+trip+monto para
   * que un reintento del cliente con la misma propina sea idempotente (no la duplica).
   */
  async tip(user: AuthenticatedUser, tripId: string, tipCents: number): Promise<PaymentView> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero');
    }
    const dedupKey = `tip:${user.userId}:${tripId}:${tipCents}`;
    const payment = await this.paymentRest.post<PaymentReply>(`/payments/${tripId}/tip`, {
      identity: user,
      idempotencyKey: dedupKey,
      body: { tipCents, dedupKey },
    });
    return {
      id: payment.id,
      tripId: payment.tripId,
      method: payment.method,
      status: payment.status,
      amountCents: payment.amountCents,
      grossCents: payment.grossCents,
      tipCents: payment.tipCents,
      commissionCents: payment.commissionCents,
      feeCents: payment.feeCents,
      externalRef: payment.externalRef ?? '',
      // La propina no abre checkout async; reflejamos lo que venga (null/"" → null) sin romper la shape.
      externalUid: payment.externalUid || null,
      checkoutUrl: payment.checkoutUrl || null,
      qrCode: payment.qrCode || null,
      deepLink: payment.deepLink || null,
      cip: payment.cip || null,
      checkoutExpiresAt: payment.checkoutExpiresAt || null,
      // La propina no falla por capacidad; reflejamos lo que venga ("" / null → null) sin romper la shape.
      failureReason: payment.failureReason || null,
    };
  }

  // ── PUJA · lado pasajero (ADR 010 §6 · ROL∩OWNERSHIP) ───────────────────────────────────────
  //
  // Las 3 operaciones del board del pasajero comparten el MISMO gate anti-IDOR que videoGrant/tip:
  // GetTrip por gRPC → si `passengerId !== user.userId` → 403. La UI nunca autoriza; el ownership se
  // verifica server-side ACÁ antes de delegar a dispatch (que es agnóstico al pasajero dueño del board).

  /** Verifica que el viaje exista y pertenezca al pasajero autenticado (anti-IDOR). Lanza si no. */
  private async assertOwnsTrip(user: AuthenticatedUser, tripId: string): Promise<void> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero');
    }
  }

  /**
   * Estado del board + ofertas del board de SU viaje (el pasajero ve "N conductores respondieron" Y el
   * ESTADO de la puja). FIX contrato: dispatch devuelve `{board:{status,expiresAt}, offers}` — el cliente
   * distingue OPEN-sin-ofertas de CANCELLED/EXPIRED/CLOSED_MATCHED/GONE sin adivinar por un array vacío.
   * Las ofertas se ENRIQUECEN (BE-1) con rating + vehículo del conductor; el `board` se pasa tal cual.
   */
  async listOffers(user: AuthenticatedUser, tripId: string): Promise<OffersResponse> {
    await this.assertOwnsTrip(user, tripId);
    const view = await this.dispatchRest.get<OffersResponse>(`/bids/${tripId}/offers`, {
      identity: user,
    });
    // BE-1 · enriquecer cada oferta con rating + vehículo del conductor (gRPC a rating/fleet, cacheado).
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const offers = await Promise.all(
      view.offers.map(async (o) => ({ ...o, ...(await this.enrichment.enrich(o.driverId, meta)) })),
    );
    return { board: view.board, offers };
  }

  /** El pasajero elige UNA oferta de SU board → match. Idempotente (doble-tap → no-op downstream). */
  async acceptOffer(user: AuthenticatedUser, tripId: string, driverId: string): Promise<OfferView> {
    await this.assertOwnsTrip(user, tripId);
    return this.dispatchRest.post<OfferView>(`/bids/${tripId}/accept`, {
      identity: user,
      idempotencyKey: `accept_offer:${user.userId}:${tripId}:${driverId}`,
      body: { driverId },
    });
  }

  /** El pasajero cancela la puja de SU viaje → board CANCELLED. Idempotente. */
  async cancelBid(user: AuthenticatedUser, tripId: string): Promise<{ ok: true }> {
    await this.assertOwnsTrip(user, tripId);
    return this.dispatchRest.post<{ ok: true }>(`/bids/${tripId}/cancel`, {
      identity: user,
      body: {},
    });
  }

  /**
   * RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4): reactiva la puja de SU viaje (REASSIGNING/EXPIRED) a
   * un nuevo bid. Mismo gate anti-IDOR que las otras operaciones del board (assertOwnsTrip → 403 si
   * ajeno) ANTES de delegar a trip-service, que re-valida ownership + estado + rango del bid
   * (autoritativo). El passengerId se fija desde la identidad, nunca del cliente. Idempotente: la
   * idempotencyKey por (passenger,trip,bid) hace que un doble-tap del mismo re-bid no abra dos boards.
   */
  async rebid(user: AuthenticatedUser, tripId: string, dto: RebidTripDto): Promise<TripResource> {
    await this.assertOwnsTrip(user, tripId);
    return this.tripRest.post<TripResource>(`/trips/${tripId}/rebid`, {
      identity: user,
      idempotencyKey: `rebid:${user.userId}:${tripId}:${dto.bidCents}`,
      body: { passengerId: user.userId, bidCents: dto.bidCents },
    });
  }
}
