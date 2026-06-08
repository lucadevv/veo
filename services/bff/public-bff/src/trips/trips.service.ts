/**
 * Dominio de viajes del pasajero. Lecturas vía gRPC (con agregación trip+conductor+rating+vehículo),
 * comandos vía REST interno firmado. El passengerId/actor se derivan SIEMPRE de la identidad
 * autenticada, nunca del cliente.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { DriverEnrichmentService } from './driver-enrichment.service';
import { INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { DomainError, NotFoundError, uuidv7 } from '@veo/utils';
import type { TripVideoGrant } from '@veo/api-client';
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
import { internalGrpcMetadata } from '../infra/internal-identity';
import { REDIS } from '../infra/redis';
import type {
  AggregateReply,
  DriverReply,
  PassengerTripsReply,
  PaymentReply,
  TripReply,
  TripStateReply,
  UserReply,
  VehicleReply,
} from '../infra/grpc-types';
import { DebtPendingError, type PaymentView } from '../payments/dto/payments.dto';
import { familyRoom } from '../share/share.types';
import { type LiveKitConfig, liveKitEnabled, mintViewerToken } from '../share/livekit-token';
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

/**
 * El pasajero debe tener la identidad verificada (liveness/KYC) antes de pedir su primer viaje.
 * Gate server-side (la UI nunca autoriza, solo refleja): si `kycStatus ≠ VERIFIED` → 403 KYC_REQUIRED
 * y la app deriva a la verificación facial. Una vez VERIFIED no se vuelve a pedir (salvo EXPIRED).
 */
export class KycRequiredError extends DomainError {
  readonly code = 'KYC_REQUIRED';
  readonly httpStatus = 403;
  constructor() {
    super('Verificá tu identidad para pedir tu primer viaje.');
  }
}

/** Resumen accionable que devuelve payment-service GET /payments/debt. */
interface DebtSummaryReply {
  hasDebt: boolean;
  debts: {
    paymentId: string;
    tripId: string;
    amountCents: number;
    reason: string;
    createdAt: string;
    /** DEBT bloquea el gate; PENDING_ACTION (pago por completar) NO. El gate SOLO mira los DEBT. */
    kind?: 'DEBT' | 'PENDING_ACTION';
  }[];
  totalCents: number;
}

/** TTL del cache del KYC verificado (positivo). Corto: acota la ventana de un eventual EXPIRED. */
const KYC_VERIFIED_CACHE_TTL_SECONDS = 300;

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
    @Inject(REDIS) private readonly redis: Redis,
    private readonly enrichment: DriverEnrichmentService,
  ) {}

  /** Crea un viaje. Idempotente: usa la Idempotency-Key del cliente o genera una UUIDv7. */
  async createTrip(
    user: AuthenticatedUser,
    dto: CreateTripDto,
    idempotencyKey?: string,
  ): Promise<TripResource> {
    // Gate de seguridad (diferenciador VEO): exige verificación facial antes del primer viaje.
    // Server-side (la app solo refleja). Cacheado para no pegarle a identity en cada pedido; el
    // servicio de registro (trip-service) lo RE-exige vía el `kycVerified` firmado (defensa en profundidad).
    await this.assertKycVerified(user);
    // Gate de deuda (BR-P02): un pasajero con un cobro en DEBT NO puede pedir un viaje nuevo (decisión
    // de producto: la deuda bloquea TODO pedido). Server-side, tras el KYC. 403 DEBT_PENDING con el
    // detalle para el banner. Cacheado SOLO el resultado sin deuda (positivo).
    await this.assertNoDebt(user);
    return this.tripRest.post<TripResource>('/trips', {
      // Defensa en profundidad: propagamos el KYC verificado FIRMADO por HMAC; trip-service (servicio
      // de registro) lo EXIGE para crear el viaje, así el gate no depende solo de este BFF.
      identity: { ...user, kycVerified: true },
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
        surgeMultiplier: dto.surgeMultiplier,
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
   * Exige que el pasajero esté VERIFIED. Cachea SOLO el positivo (estado terminal salvo EXPIRED) en
   * Redis con TTL corto, para no consultar identity en CADA pedido (hot-path). El negativo NUNCA se
   * cachea: un pasajero recién verificado debe poder viajar al instante. Si Redis está caído, se
   * IGNORA el cache y se consulta la fuente autoritativa (identity) — nunca hace bypass.
   */
  private async assertKycVerified(user: AuthenticatedUser): Promise<void> {
    const cacheKey = `kyc:verified:${user.userId}`;
    try {
      if ((await this.redis.get(cacheKey)) === '1') {
        return;
      }
    } catch {
      // Redis no disponible: caemos a la verificación autoritativa (no bypass).
    }
    const meta = internalGrpcMetadata(user, this.secret);
    const me = await this.identityGrpc.call<UserReply>('GetUser', { id: user.userId }, meta);
    if (me.kycStatus !== 'VERIFIED') {
      throw new KycRequiredError();
    }
    try {
      await this.redis.set(cacheKey, '1', 'EX', KYC_VERIFIED_CACHE_TTL_SECONDS);
    } catch {
      // best-effort: si no se pudo cachear, el próximo pedido reconsulta.
    }
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
    const summary = await this.paymentRest.get<DebtSummaryReply>('/payments/debt', { identity: user });
    // El gate SOLO bloquea por DEUDA real (kind=DEBT). `hasDebt`/`totalCents` ya resumen solo los DEBT;
    // un PENDING_ACTION (pago por completar) viaja en `debts` pero NO debe bloquear ni contar (un pago
    // a medio completar no es una deuda). Defensa en profundidad: derivamos el oldestTripId del primer
    // DEBT explícitamente (no del primer item, que podría ser un PENDING_ACTION si el orden cambiara).
    if (summary.hasDebt) {
      // CON deuda: NUNCA cachear. Bloqueo inmediato con el detalle para el banner de la app.
      const realDebts = summary.debts.filter((d) => (d.kind ?? 'DEBT') === 'DEBT');
      const oldestTripId = realDebts[0]?.tripId ?? null;
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
    const meta = internalGrpcMetadata(user, this.secret);
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
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
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
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetActiveTrip', { passengerId: user.userId }, meta);
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
    const meta = internalGrpcMetadata(user, this.secret);
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
    const meta = internalGrpcMetadata(user, this.secret);
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
    meta: ReturnType<typeof internalGrpcMetadata>,
  ): Promise<TripDetailView> {
    const [driver, vehicle, aggregate, myRating] = await Promise.all([
      trip.driverId
        ? this.identityGrpc.call<DriverReply>('GetDriver', { id: trip.driverId }, meta).catch(() => null)
        : Promise.resolve(null),
      trip.vehicleId
        ? this.fleetGrpc.call<VehicleReply>('GetVehicle', { id: trip.vehicleId }, meta).catch(() => null)
        : Promise.resolve(null),
      trip.driverId
        ? this.ratingGrpc.call<AggregateReply>('GetAggregate', { subjectId: trip.driverId }, meta).catch(() => null)
        : Promise.resolve(null),
      // MI rating de este viaje (REST firmado, filtrado por el rater = identidad). Best-effort en el
      // mismo Promise.all que los otros 3: 1 call extra barata para que el detalle / la re-entrada del
      // cierre traigan el estado del rating sin un GET aparte. 404 (sin rating) → null; cualquier otro
      // fallo también → null (degradación grácil: la app cae al GET /ratings?tripId on-demand).
      this.fetchMyRatingStars(user, trip.id),
    ]);

    return buildTripDetail(
      trip,
      driver?.found ? driver : null,
      aggregate?.found ? aggregate : null,
      vehicle?.found ? vehicle : null,
      0,
      myRating,
    );
  }

  /** Estrellas de MI rating de un viaje (REST firmado, rater=identidad), o null. Nunca lanza (best-effort). */
  private async fetchMyRatingStars(user: AuthenticatedUser, tripId: string): Promise<number | null> {
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
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
    }
    const state = await this.tripGrpc.call<TripStateReply>('GetTripState', { id: tripId }, meta);
    if (!state.found) throw new NotFoundError('Viaje no encontrado');
    return buildTripState(state);
  }

  /**
   * Token de video del habitáculo (LiveKit self-hosted) para el pasajero en SU viaje en curso.
   * - Si LiveKit no está configurado → 404 (la app degrada a "sin video").
   * - Solo autoriza si el viaje es del pasajero autenticado y está IN_PROGRESS.
   * Devuelve un token viewer (solo suscripción) firmado para la sala `trip:<tripId>`.
   */
  async videoGrant(user: AuthenticatedUser, tripId: string): Promise<TripVideoGrant> {
    if (!liveKitEnabled(this.livekit)) {
      throw new NotFoundException('El video del habitáculo no está disponible');
    }
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
    }
    if (trip.status !== 'IN_PROGRESS') {
      throw new ForbiddenException('La cámara solo está disponible durante el viaje en curso');
    }
    const room = familyRoom(tripId);
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
   * Propina del pasajero a SU viaje ya cobrado (BR-P04). 100% al conductor, fuera de comisión.
   * Verifica que el viaje pertenece al pasajero autenticado (gRPC GetTrip) antes de delegar al
   * payment-service por REST interno firmado. La dedupKey se deriva del passenger+trip+monto para
   * que un reintento del cliente con la misma propina sea idempotente (no la duplica).
   */
  async tip(user: AuthenticatedUser, tripId: string, tipCents: number): Promise<PaymentView> {
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
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
    const meta = internalGrpcMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
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
    const meta = internalGrpcMetadata(user, this.secret);
    const offers = await Promise.all(
      view.offers.map(async (o) => ({ ...o, ...(await this.enrichment.enrich(o.driverId, meta)) })),
    );
    return { board: view.board, offers };
  }

  /** El pasajero elige UNA oferta de SU board → match. Idempotente (doble-tap → no-op downstream). */
  async acceptOffer(
    user: AuthenticatedUser,
    tripId: string,
    driverId: string,
  ): Promise<OfferView> {
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
