/**
 * TripsService — orquesta el ciclo de vida del viaje aplicando las reglas de dominio:
 *  - BR-T02 máquina de estados (delegada a trip-state-machine).
 *  - BR-T05 tarifa en céntimos PEN a partir de la ruta de @veo/maps.
 *  - BR-T01 tarifa inmutable salvo cambio de destino explícito.
 *  - BR-T03 penalización de cancelación.
 *  - BR-T07 modo niño (hash bcrypt del código; validación en el recojo).
 *
 * Toda mutación de dominio + el insert en outbox_events ocurren en la MISMA transacción Prisma.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  uuidv7,
  parseOrThrow,
  geoPointSchema,
  childCodeSchema,
  BID_MAX_CENTS,
  type LatLon,
} from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { PricingMode, TripStatus, VehicleType } from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import type Redis from 'ioredis';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import {
  Prisma,
  type Trip,
  VehicleType as PrismaVehicleType,
  PricingMode as PrismaPricingMode,
} from '../generated/prisma';
import { assertTransition, InvalidTripTransition, LIVE_STATES, transitionSources } from './domain/trip-state-machine';
import { ActiveTripExistsError } from './trips.errors';
import {
  resolveStalledTarget,
  WATCHED_STATES,
  type WatchdogThresholds,
  type StalledTarget,
} from './domain/watchdog';
import { calculateFare } from './domain/fare';
import { calculateCancellationPenalty } from './domain/cancellation';
import { assertScheduleWindow } from './domain/scheduling';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  historyWhere,
  tripToHistoryItem,
  type TripHistoryPage,
} from './domain/history';
import { toZone, type ZoneKey } from './domain/pricing-mode';
import { toTripView, readWaypoints } from './trip-view.mapper';
import { PricingScheduleService } from '../pricing/pricing-schedule.service';
import type { Env } from '../config/env.schema';
import type {
  AcceptTripDto,
  ArrivingTripDto,
  AssignTripDto,
  CancelTripDto,
  ChangeDestinationDto,
  CompleteTripDto,
  CreateTripDto,
  StartTripDto,
  TripView,
} from './dto/trip.dto';

const BCRYPT_ROUNDS = 10;
const PRODUCER = 'trip-service';

/**
 * B · Lockout anti-brute-force del código de modo niño (BR-T07). Un código de 4-6 dígitos es
 * fuerza-brutaleable sin límite de reintentos. Decisión del dueño (fija): 5 intentos fallidos →
 * bloqueo de 15 minutos. Contador y candado viven en Redis (no en Postgres): TTL nativo + atomicidad
 * de INCR, y NO requieren migración (V2 sin cambio de schema).
 */
const CHILD_CODE_MAX_ATTEMPTS = 5;
const CHILD_CODE_LOCK_SECONDS = 15 * 60; // 900s
const childCodeAttemptsKey = (tripId: string): string => `childcode:attempts:${tripId}`;
const childCodeLockKey = (tripId: string): string => `childcode:lock:${tripId}`;

/**
 * Defaults de la puja (ADR 010 §9). Se usan si no se inyecta ConfigService (p.ej. en tests unitarios)
 * o como respaldo. En producción los valores efectivos vienen de env (BID_FLOOR_CENTS / BID_WINDOW_SEC).
 */
const DEFAULT_BID_FLOOR_CENTS = 700; // S/7 — piso global temporal (per-zona pendiente, §9.3)
const DEFAULT_BID_MAX_CENTS = BID_MAX_CENTS; // techo canónico (@veo/utils, S/ 9,999) — anti-overflow int4
const DEFAULT_BID_WINDOW_SEC = 60; // ventana de puja (§9.1)
const DEFAULT_MAX_REASSIGN = 3; // tope de re-asignaciones (robustez #4, anti bucle infinito)

/** Estados desde los que aún se puede cambiar el destino (antes de iniciar el viaje). */
const DESTINATION_EDITABLE: ReadonlySet<TripStatus> = new Set([
  TripStatus.REQUESTED,
  TripStatus.ASSIGNED,
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
]);

/**
 * Estados POST-accept del conductor (ADR 010 #4): si el conductor cancela desde aquí, el viaje se
 * REASIGNA (no termina). ASSIGNED queda fuera a propósito: ahí el conductor aún no aceptó, su cancel
 * sigue siendo terminal CANCELLED_BY_DRIVER.
 */
const POST_ACCEPT_STATES: ReadonlySet<TripStatus> = new Set([
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
]);

/**
 * N9 — Estados en los que tiene sentido grabar un precio acordado (NO terminales). Un
 * `dispatch.offer_accepted` tardío/duplicado NO debe escribir `fareCents` ni registrar `trip.fare_agreed`
 * sobre un viaje CANCELLED/EXPIRED/FAILED/COMPLETED ya cerrado. Es el complemento (no-terminal) del set
 * canónico de terminales {CANCELLED_BY_PASSENGER, CANCELLED_BY_DRIVER, EXPIRED, FAILED, COMPLETED}.
 */
const FARE_APPLICABLE_STATES: readonly TripStatus[] = [
  TripStatus.REQUESTED,
  TripStatus.ASSIGNED,
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
  TripStatus.IN_PROGRESS,
];

type TxClient = Prisma.TransactionClient;

/**
 * Puerto del ModeResolver (ADR 011 §1.1) que createTrip consume para CONGELAR el modo del viaje. La
 * implementación real es PricingScheduleService (carga el schedule + delega en el resolver puro). Se
 * tipa como interfaz para que el servicio NO dependa de la clase concreta (clean arch) y para que los
 * tests unitarios inyecten un doble determinista.
 */
export interface ModeResolverPort {
  resolve(zone: ZoneKey, now: Date): Promise<PricingMode>;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  /** Piso del bid en céntimos PEN (ADR 010 §9.3 · degradación honesta a piso global temporal). */
  private readonly bidFloorCents: number;
  /**
   * Techo del bid/contraoferta en céntimos PEN (guardarraíl anti-abuso/anti-overflow int4). Es el
   * gate de dominio AUTORITATIVO: ni el bid inicial ni el precio acordado (COUNTER) pueden superarlo.
   */
  private readonly bidMaxCents: number;
  /** Ventana de la puja en segundos (ADR 010 §9.1). */
  private readonly bidWindowSec: number;
  /** Tope de re-asignaciones tras cancelación del conductor post-accept (PUJA robustez #4). */
  private readonly maxReassign: number;

  /**
   * ModeResolver (ADR 011 §1.1) que resuelve PUJA|FIXED en createTrip. En producción es
   * PricingScheduleService (inyectado): carga el schedule admin + delega en el resolver puro. Si no se
   * inyecta (tests legacy H1-H13 que construyen el servicio con 2 args, que NUNCA conocieron el schedule),
   * `null` ⇒ createTrip degrada a la derivación M1-compatible bidCents-driven (presencia de bid ⇒ PUJA,
   * si no ⇒ FIXED), preservando su comportamiento. Los tests NUEVOS de server-resolution inyectan un doble.
   */
  private readonly modeResolver: ModeResolverPort | null;

  /**
   * Cliente Redis para el lockout anti-brute-force del código de modo niño (B). `@Optional()` para no
   * romper los tests legacy que construyen el servicio sin Redis (childMode sin lockout): si no se
   * inyecta, el gate de modo niño cae al comportamiento previo (validación de código sin contador).
   * En producción CoreModule lo provee (REDIS, global).
   */
  private readonly redis: Pick<Redis, 'get' | 'incr' | 'expire' | 'del' | 'set'> | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Optional() config?: ConfigService<Env, true>,
    @Optional() modeResolver?: PricingScheduleService,
    @Optional() @Inject(REDIS) redis?: Pick<Redis, 'get' | 'incr' | 'expire' | 'del' | 'set'>,
  ) {
    this.bidFloorCents = config?.get('BID_FLOOR_CENTS') ?? DEFAULT_BID_FLOOR_CENTS;
    this.bidMaxCents = config?.get('BID_MAX_CENTS') ?? DEFAULT_BID_MAX_CENTS;
    this.bidWindowSec = config?.get('BID_WINDOW_SEC') ?? DEFAULT_BID_WINDOW_SEC;
    this.maxReassign = config?.get('TRIP_MAX_REASSIGN') ?? DEFAULT_MAX_REASSIGN;
    this.modeResolver = modeResolver ?? null;
    this.redis = redis ?? null;
  }

  /**
   * Resuelve el modo de despacho AUTORITATIVO del viaje (ADR 011 §1.2 · resolve-once). Con resolver
   * inyectado → server-resolved desde el schedule admin (zona, ahora). Sin resolver (tests legacy) →
   * derivación M1-compatible bidCents-driven. El resultado se CONGELA en Trip.dispatchMode.
   */
  private async resolveDispatchMode(zone: ZoneKey, now: Date, hasBid: boolean): Promise<PricingMode> {
    if (this.modeResolver) return this.modeResolver.resolve(zone, now);
    return hasBid ? PricingMode.PUJA : PricingMode.FIXED;
  }

  /**
   * Piso del bid para una zona (ADR 010 §9.3). Decisión RATIFICADA: el piso canónico es Admin·Pricing
   * POR ZONA (motor de tarifas expone floor(zona)). Ese motor AÚN NO existe/está expuesto, así que
   * degradamos HONESTAMENTE al piso GLOBAL de config (BID_FLOOR_CENTS, default S/7). El parámetro
   * `origin` queda como punto de extensión: cuando exista el floor por zona, se resuelve aquí.
   */
  private resolveBidFloorCents(_origin: LatLon): number {
    return this.bidFloorCents;
  }

  // ───────────────────────────── Creación / cotización ─────────────────────────────

  /**
   * POST /trips — crea (y cotiza) un viaje.
   *  - Inmediato → estado REQUESTED y emite trip.requested (dispatch lo recoge).
   *  - Programado (scheduledFor, Ola 2B) → estado SCHEDULED; NO emite trip.requested aún: el
   *    scheduler lo activará a la hora (menos el lead time). Solo registra trip.scheduled.
   * Soporta paradas múltiples (waypoints) en la ruta y tarifa, y tier vehicleType (CAR|MOTO).
   */
  async createTrip(dto: CreateTripDto, idempotencyKey?: string): Promise<TripView> {
    // Idempotencia de creación: misma clave ⇒ mismo viaje (no se duplica).
    if (idempotencyKey) {
      const existing = await this.prisma.read.trip.findUnique({ where: { idempotencyKey } });
      if (existing) return toTripView(existing);
    }

    const origin = parseOrThrow(geoPointSchema, dto.origin, 'origin');
    const destination = parseOrThrow(geoPointSchema, dto.destination, 'destination');
    // Ola 2B · paradas múltiples: validamos cada punto; el orden es significativo.
    const waypoints: LatLon[] = (dto.waypoints ?? []).map((w, i) =>
      parseOrThrow(geoPointSchema, w, `waypoints[${i}]`),
    );

    if (dto.childMode && !dto.childCode) {
      throw new ValidationError('El modo niño requiere un código de 4-6 dígitos (BR-T07)');
    }
    const childCodeHash = dto.childMode
      ? bcrypt.hashSync(parseOrThrow(childCodeSchema, dto.childCode, 'childCode'), BCRYPT_ROUNDS)
      : null;

    // Ola 2B · viaje programado: si llega scheduledFor, validamos la ventana y el viaje nace SCHEDULED.
    const scheduledFor = dto.scheduledFor
      ? assertScheduleWindow(new Date(dto.scheduledFor), new Date())
      : null;
    const initialStatus = scheduledFor ? TripStatus.SCHEDULED : TripStatus.REQUESTED;

    // Invariante "una sola experiencia de viaje": un pasajero solo puede tener UN viaje VIVO a la vez.
    // Si pide uno INMEDIATO teniendo otro en curso → 409 ACTIVE_TRIP_EXISTS con el activeTripId, para
    // que la app lo devuelva a su viaje activo (re-entrada) en vez de duplicar. Gate AUTORITATIVO acá
    // (no en la UI). Solo inmediatos: reservar a futuro (SCHEDULED) no crea un viaje vivo. Leemos del
    // primario (write) para no perder un viaje recién creado por lag de réplica (evita la carrera de
    // doble-pedido). La idempotency-key ya cubrió el doble-tap del MISMO pedido más arriba.
    if (!scheduledFor) {
      const live = await this.prisma.write.trip.findFirst({
        where: { passengerId: dto.passengerId, status: { in: [...LIVE_STATES] } },
        select: { id: true },
        orderBy: { requestedAt: 'desc' },
      });
      if (live) {
        throw new ActiveTripExistsError(live.id);
      }
    }

    const vehicleType: PrismaVehicleType = dto.vehicleType ?? VehicleType.CAR;

    // Ruta multi-punto (origen → paradas → destino): distancia/duración incluyen las paradas. La
    // ruta sigue alimentando distancia/duración/polyline aunque el precio venga del bid (la puja no
    // cambia la geometría; la distancia es necesaria para la penalización BR-T03 y las pantallas).
    const route = await this.maps.route(origin, destination, waypoints);
    const surge = dto.surgeMultiplier ?? 1.0;

    // ADR 011 §1.2/§4 · resolve-once-persist-forever: el SERVIDOR resuelve el modo de despacho UNA vez
    // acá (autoritativo: zona + instante + schedule admin), ignorando lo que mande el cliente. Reemplaza
    // el viejo fork client-driven por presencia de `dto.bidCents`. El modo se CONGELA en Trip.dispatchMode.
    //
    // S2 (ADR 011) — LOCK-AT-BOOKING: para una RESERVA (scheduledFor futuro) resolvemos con la hora de
    // RECOJO, no la de creación. Un viaje pedido a las 14:00 para recoger a las 22:00 toma la política de
    // las 22:00 (la que el pasajero VIO en el quote), no la de las 14:00. El modo SIGUE congelándose una
    // sola vez al crear (persist-once intacto): si el admin cambia la política de esa hora DESPUÉS de la
    // reserva, el viaje ya reservado conserva lo que se le prometió — predecible y honesto. Inmediato →
    // `scheduledFor` es null → resolvemos con `now` (sin cambio de comportamiento).
    const now = new Date();
    const resolveAt = scheduledFor ?? now;
    const mode = await this.resolveDispatchMode(toZone(origin), resolveAt, dto.bidCents !== undefined);
    const isBid = mode === PricingMode.PUJA;

    // El modo elegido por el SERVIDOR decide cómo se fija la tarifa:
    //  - PUJA (ADR 010 §2): REQUIERE el bid del pasajero (validado piso ≤ bid ≤ techo). Ese bid ES el
    //    fareCents (no la tarifa por ruta); el surge solo SUGIERE (decisión #5), no se aplica al bid. Si
    //    falta el bid → 400 "falta tu oferta" (el quote ya lo pidió; no asumimos un precio, §5).
    //  - FIXED: IGNORA cualquier `dto.bidCents` que llegue (la app ya mostró tarifa fija vía el quote);
    //    se calcula la tarifa firme por ruta (BR-T05).
    let fareCents: number;
    if (mode === PricingMode.PUJA) {
      if (dto.bidCents === undefined) {
        throw new ValidationError('falta tu oferta', { mode });
      }
      const floor = this.resolveBidFloorCents(origin);
      if (dto.bidCents < floor) {
        throw new ValidationError(
          `El bid (${dto.bidCents}) es menor al piso de la zona (${floor}) (ADR 010 §9.3)`,
          { bidCents: dto.bidCents, floorCents: floor },
        );
      }
      // Techo del bid (gate AUTORITATIVO): un bid desbocado overflowea el int4 de fareCents y/o fluye
      // al cobro como tarifa. Lo rechazamos acá (espeja el chequeo de piso), no solo en el DTO.
      if (dto.bidCents > this.bidMaxCents) {
        throw new ValidationError(
          `El bid (${dto.bidCents}) supera el techo permitido (${this.bidMaxCents}) (ADR 010)`,
          { bidCents: dto.bidCents, maxCents: this.bidMaxCents },
        );
      }
      fareCents = dto.bidCents;
    } else {
      const fare = calculateFare({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        surgeMultiplier: surge,
        childMode: dto.childMode ?? false,
      });
      fareCents = fare.cents;
    }
    const currency = 'PEN';

    // ADR 011 · el modo RESUELTO se CONGELA en la fila del viaje. Reasignación / activación de
    // programados leen ESTE modo (dispatchMode), NUNCA re-resuelven de la config admin actual (§1.2).
    const dispatchMode: PrismaPricingMode = mode;

    const id = uuidv7();
    const trip = await this.prisma.write.$transaction(async (tx) => {
      const created = await tx.trip.create({
        data: {
          id,
          passengerId: dto.passengerId,
          originLat: origin.lat,
          originLon: origin.lon,
          destLat: destination.lat,
          destLon: destination.lon,
          waypoints: waypoints.length > 0 ? (waypoints as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          scheduledFor,
          vehicleType,
          // ADR 011: modo de despacho congelado del viaje (PUJA si hubo bid, FIXED si tarifa por ruta).
          dispatchMode,
          fareCents,
          currency,
          surgeMultiplier: new Prisma.Decimal(surge),
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          paymentMethod: dto.paymentMethod,
          status: initialStatus,
          routePolyline: route.polyline || null,
          // Categoría elegida en la cotización: se PERSISTE tal cual (quoteOption.id). La tarifa
          // firme no se recalcula por categoría aquí; el multiplicador por categoría es de la
          // previsualización del BFF (maps/fare.ts). Si se modela tarifa por categoría a futuro,
          // este es el punto donde alimentar calculateFare con el multiplicador correspondiente.
          category: dto.category ?? null,
          childMode: dto.childMode ?? false,
          childCodeHash,
          promoCode: dto.promoCode ?? null,
          // BE-2 · solicitudes especiales (mascota/equipaje/silla). El conductor las ve antes de aceptar.
          specialRequests: dto.specialRequests ?? [],
          idempotencyKey: idempotencyKey ?? null,
          // H13 — la puja abre el PRIMER ciclo de negociación (seq=1); el camino legacy sin bid queda en 0
          // (nunca emite offer_accepted → applyAgreedFare no aplica). El seq es monotónico: rebid y la
          // reasignación lo INCREMENTAN (nunca resetean, a diferencia de reassignCount).
          negotiationSeq: isBid ? 1 : 0,
        },
      });

      if (scheduledFor) {
        // Programado: no entra a dispatch todavía. Solo registramos la reserva (el scheduler activa).
        // Nota: la activación programada usa el camino legacy trip.requested (la puja diferida es un
        // follow-up — ver REPORT). El precio ya quedó fijado (bid o tarifa por ruta) al crear.
        await this.recordEvent(tx, created.id, 'trip.scheduled', {
          scheduledFor: scheduledFor.toISOString(),
          fareCents,
          vehicleType,
          waypoints: waypoints.length,
        });
      } else if (isBid) {
        // PUJA (ADR 010 §2): el bid abre la negociación. Emitimos trip.bid_posted → dispatch abre el
        // OfferBoard y hace broadcast a conductores elegibles. REEMPLAZA a trip.requested en el camino
        // de puja: NO emitimos trip.requested aquí para no disparar el auto-offer secuencial legacy.
        await this.emitBidPosted(tx, created, origin);
      } else {
        // Compat: sin bid → flujo previo (tarifa por ruta) que dispara el matching legacy.
        await this.emitTripRequested(tx, created, origin, destination);
      }
      return created;
    });

    return toTripView(trip);
  }

  /**
   * Inserta el evento de dominio + outbox trip.requested para que dispatch arranque el matching.
   * Extraído para reutilizarlo desde createTrip (inmediato) y desde la activación del scheduler.
   * `scheduled` marca el origen (reserva) para que dispatch pueda señalar "reservado" en la oferta.
   */
  private async emitTripRequested(
    tx: TxClient,
    trip: Trip,
    origin: LatLon,
    destination: LatLon,
  ): Promise<void> {
    const scheduled = trip.scheduledFor !== null;
    await this.recordEvent(tx, trip.id, 'trip.requested', {
      fareCents: trip.fareCents,
      distanceMeters: trip.distanceMeters,
      durationSeconds: trip.durationSeconds,
      surge: Number(trip.surgeMultiplier.toString()),
      category: trip.category,
      vehicleType: trip.vehicleType,
      scheduled,
    });
    await enqueueOutbox(
      tx,
      createEnvelope({
        eventType: 'trip.requested',
        producer: PRODUCER,
        payload: {
          tripId: trip.id,
          passengerId: trip.passengerId,
          origin,
          destination,
          fareCents: trip.fareCents,
          childMode: trip.childMode,
          // Ola 2B: dispatch filtra el matching por tipo de vehículo (MOTO solo a conductores MOTO).
          vehicleType: trip.vehicleType,
          // Ola 2B: si el viaje proviene de una reserva, dispatch puede incluirlo como "reservado".
          scheduled,
        },
      }),
      trip.id,
    );
  }

  /**
   * PUJA (ADR 010 §2/§4) · entrada a la negociación. Inserta el evento de dominio + outbox
   * `trip.bid_posted` en la MISMA transacción de creación. dispatch abre el OfferBoard con este bid
   * y hace broadcast a conductores elegibles (ventana de puja = BID_WINDOW_SEC). `bidCents` =
   * `fareCents` del viaje (ya validado ≥ piso). REEMPLAZA a `trip.requested` en el camino de puja.
   */
  /**
   * @param scheduled `true` SOLO cuando el bid nace de activar una reserva (cron → activateScheduledTrip):
   *   el pasajero NO está en la app y notification-service le mandará un push con deep-link al board.
   *   `false` en la puja inmediata y en el rebid (el pasajero ya está mirando el board).
   */
  private async emitBidPosted(
    tx: TxClient,
    trip: Trip,
    origin: LatLon,
    scheduled = false,
  ): Promise<void> {
    await this.recordEvent(tx, trip.id, 'trip.bid_posted', {
      bidCents: trip.fareCents,
      vehicleType: trip.vehicleType,
      windowSec: this.bidWindowSec,
      // H13 — sella el ciclo de negociación que abrió este bid (createTrip=1, rebid=trip.negotiationSeq+1).
      negotiationSeq: trip.negotiationSeq,
      scheduled,
    });
    await enqueueOutbox(
      tx,
      createEnvelope({
        eventType: 'trip.bid_posted',
        producer: PRODUCER,
        payload: {
          tripId: trip.id,
          passengerId: trip.passengerId,
          bidCents: trip.fareCents,
          vehicleType: trip.vehicleType,
          origin,
          windowSec: this.bidWindowSec,
          // H13 — dispatch persiste este seq en el board y lo estampa en dispatch.offer_accepted.
          negotiationSeq: trip.negotiationSeq,
          // BE-2 — el conductor las ve en su vista de puja (dispatch las guarda en el board).
          specialRequests: trip.specialRequests,
          // #1 — activación de reserva: notification-service pushea al pasajero (deep-link al board).
          scheduled,
        },
      }),
      trip.id,
    );
  }

  // ───────────────────────────── Lectura ─────────────────────────────

  async getTrip(id: string): Promise<TripView> {
    return toTripView(await this.mustFind(id));
  }

  async getTripState(id: string): Promise<{ id: string; status: TripStatus }> {
    const trip = await this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return { id: trip.id, status: trip.status };
  }

  /**
   * GET /trips/scheduled?passengerId= — viajes PROGRAMADOS aún no activados de un pasajero (Ola 2B).
   * Orden ascendente por hora programada (los más próximos primero).
   */
  async listScheduled(passengerId: string): Promise<TripView[]> {
    const trips = await this.prisma.read.trip.findMany({
      where: { passengerId, status: TripStatus.SCHEDULED },
      orderBy: { scheduledFor: 'asc' },
    });
    return trips.map((t) => toTripView(t));
  }

  /**
   * Historial REAL del pasajero (servidor, no MMKV local): SUS viajes ordenados por requestedAt DESC,
   * id DESC, paginados por CURSOR (keyset). Es la fuente de verdad de los ESTADOS reales (COMPLETED /
   * CANCELLED_* / EXPIRED), que la lista local de la app no tiene. El passengerId lo fija el BFF desde
   * el JWT (anti-IDOR): este método NUNCA recibe el id del cliente.
   *
   * Paginación keyset (no offset): pedimos `take = limit + 1` para SABER si hay siguiente página sin un
   * COUNT extra. Si vinieron limit+1 filas, la última sobra (es el "peek"): la usamos para construir el
   * nextCursor y la recortamos. Si vinieron ≤ limit, no hay más (nextCursor = null).
   *
   * Anti-N+1: el item NO trae el nombre del conductor (solo driverId). La card muestra tier+ruta+monto+
   * estado; el nombre lo resuelve el DETALLE (GetTrip) on-demand al abrir el viaje.
   */
  async listPassengerTrips(
    passengerId: string,
    rawCursor?: string,
    rawLimit?: number,
  ): Promise<TripHistoryPage> {
    const limit = clampLimit(rawLimit);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.prisma.read.trip.findMany({
      where: historyWhere(passengerId, cursor),
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // peek: 1 fila extra para saber si hay siguiente página sin COUNT
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ requestedAt: last.requestedAt.toISOString(), id: last.id })
        : null;
    return { items: page.map((t) => tripToHistoryItem(t)), nextCursor };
  }

  // ───────────────────────────── Cierre post-viaje (re-entrada) ─────────────────────────────

  /**
   * Pending settlement: el viaje MÁS VIEJO del pasajero con status=COMPLETED y passengerClosedAt=null
   * (orden completedAt ASC), o null si no hay ninguno. Es la fuente de verdad para RE-OFRECER el
   * cierre post-viaje (recibo + confirmar efectivo + rating) tras un reload de la app: COMPLETED es
   * TERMINAL y queda FUERA de LIVE_STATES, así que GetActiveTrip no lo devuelve y el pasajero perdería
   * el cierre. Acá NO mutamos nada (lectura): el cierre lo sella `closeByPassenger`. El passengerId lo
   * fija el BFF desde la identidad autenticada (el cliente nunca lo provee).
   *
   * ORDEN FIFO (asc, el más VIEJO primero) y NO desc: si quedan varios COMPLETED sin cerrar (p.ej. la app
   * se cerró antes de confirmar un efectivo y luego se pidió otro viaje), drenamos en cascada del más
   * antiguo al más nuevo. Con desc, la plata pendiente de un efectivo VIEJO quedaba enterrada bajo viajes
   * nuevos y nunca se confirmaba; con asc cada cierre destapa el siguiente más viejo hasta vaciar la cola.
   */
  async getPendingSettlement(passengerId: string): Promise<TripView | null> {
    const trip = await this.prisma.read.trip.findFirst({
      where: { passengerId, status: TripStatus.COMPLETED, passengerClosedAt: null },
      orderBy: { completedAt: 'asc' },
    });
    return trip ? toTripView(trip) : null;
  }

  /**
   * Cierre post-viaje por el pasajero (re-entrada): sella passengerClosedAt=now() sobre SU viaje
   * COMPLETED. NO toca la máquina de estados (COMPLETED sigue terminal): passengerClosedAt es un flag de
   * UX, no un estado. Tras esto el viaje deja de aparecer en pending settlement.
   *
   * - IDEMPOTENTE: si ya estaba cerrado, devuelve la vista tal cual (no re-escribe, no error).
   * - ANTI-ENUMERACIÓN: viaje inexistente o de OTRO pasajero → NotFoundError (mismo 'Viaje no encontrado'
   *   que cancelScheduledTrip/cancel/start; no se filtra la existencia de un viaje ajeno).
   * - Solo COMPLETED puede cerrarse (un viaje vivo/cancelado no tiene cierre post-viaje que sellar).
   */
  async closeByPassenger(tripId: string, passengerId: string): Promise<TripView> {
    const trip = await this.mustFind(tripId);
    if (trip.passengerId !== passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id: tripId }); // no se filtra existencia ajena
    }
    if (trip.status !== TripStatus.COMPLETED) {
      throw new ConflictError('Solo un viaje completado puede cerrarse', { status: trip.status });
    }
    // Idempotente: ya cerrado → devolvemos la vista actual sin re-escribir (un reintento es ok, no error).
    if (trip.passengerClosedAt !== null) {
      return toTripView(trip);
    }
    const updated = await this.prisma.write.trip.update({
      where: { id: tripId },
      data: { passengerClosedAt: new Date() },
    });
    return toTripView(updated);
  }

  // ───────────────────────────── Viajes programados (Ola 2B) ─────────────────────────────

  /**
   * Activación de UN viaje programado (la invoca el scheduler/cron). Transiciona SCHEDULED →
   * REQUESTED y emite trip.requested (dispatch arranca el matching como en un viaje normal).
   * Idempotente: si el viaje ya no está SCHEDULED (otro tick lo activó, o fue cancelado), no hace nada.
   */
  async activateScheduledTrip(id: string): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id } });
    if (!trip) return;
    if (trip.status !== TripStatus.SCHEDULED) return; // ya activado/cancelado: idempotente
    assertTransition(trip.status, TripStatus.REQUESTED);

    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };

    await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera: solo activa si SIGUE SCHEDULED (no two-tick double dispatch).
      const updated = await tx.trip.updateMany({
        where: { id, status: TripStatus.SCHEDULED },
        data: { status: TripStatus.REQUESTED, activatedAt: new Date(), requestedAt: new Date() },
      });
      if (updated.count === 0) return; // otro tick ganó la carrera
      const activated: Trip = { ...trip, status: TripStatus.REQUESTED };
      // ADR 011 §1.2/§4 · resolve-once: la activación respeta el modo CONGELADO del viaje (resuelto al
      // CREAR la reserva), NO re-resuelve de la config admin actual. PUJA → abre el OfferBoard
      // (trip.bid_posted); FIXED → matching secuencial de tarifa fija (trip.requested). (Antes la
      // activación caía SIEMPRE a trip.requested; ADR 011 lo corrige a respetar el dispatchMode.)
      if (trip.dispatchMode === PricingMode.PUJA) {
        // #1 — scheduled=true: el pasajero no está en la app; notification-service le manda el push
        // con deep-link al board (sin esto, el board se llenaba de ofertas que nadie veía y expiraba).
        await this.emitBidPosted(tx, activated, origin, true);
      } else {
        await this.emitTripRequested(tx, activated, origin, destination);
      }
    });
    this.logger.log(`Viaje programado ${id} activado → REQUESTED (modo ${trip.dispatchMode})`);
  }

  /**
   * DELETE /trips/:id/schedule — cancela un viaje PROGRAMADO antes de su activación (Ola 2B).
   * SIN penalidad: aún no hubo asignación ni conductor en camino (BR-T03 no aplica a una reserva).
   * Solo permitido en estado SCHEDULED; si ya se activó, debe usarse el flujo de cancelación normal.
   */
  async cancelScheduledTrip(id: string, passengerId: string): Promise<TripView> {
    const trip = await this.mustFind(id);
    if (trip.passengerId !== passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id }); // no se filtra existencia ajena
    }
    if (trip.status !== TripStatus.SCHEDULED) {
      throw new ConflictError('El viaje ya no está programado; usa la cancelación normal', {
        status: trip.status,
      });
    }
    assertTransition(trip.status, TripStatus.CANCELLED_BY_PASSENGER);
    const now = new Date();
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: {
          status: TripStatus.CANCELLED_BY_PASSENGER,
          cancelledAt: now,
          cancelledBy: 'PASSENGER',
          cancellationReason: 'scheduled_cancelled',
          penaltyCents: 0, // sin penalidad por cancelar una reserva con antelación
        },
      });
      await this.recordEvent(tx, id, 'trip.cancelled', { by: 'PASSENGER', penaltyCents: 0, scheduled: true });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.cancelled',
          producer: PRODUCER,
          payload: { tripId: id, by: 'PASSENGER', reason: 'scheduled_cancelled', penaltyCents: 0, passengerId: trip.passengerId },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * Selecciona los viajes programados que YA deben activarse (faltan ≤ lead time). La consulta se
   * delega aquí para que el scheduler quede fino. `dueBefore` = now + leadMs.
   */
  async findDueScheduled(dueBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.read.trip.findMany({
      where: { status: TripStatus.SCHEDULED, scheduledFor: { lte: dueBefore } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ───────────────────────────── Watchdog de estado (sweeper temporal) ─────────────────────────────

  /**
   * Selecciona viajes NO terminales cuya última actividad (`updatedAt`) es anterior al corte más
   * permisivo de los umbrales del watchdog. Es un PRE-FILTRO barato: el cron decide por viaje el
   * terminal concreto con `resolveStalledTarget` (umbral por familia de estado). Devolvemos snapshot
   * mínimo (id, status, passengerId, driverId, updatedAt) para no recargar el viaje completo.
   *
   * `staleBefore` debe ser el corte MÁS ANTIGUO posible (el mayor de los umbrales) para no perder
   * candidatos; el filtrado fino por estado lo hace el dominio.
   */
  async findStalledCandidates(
    staleBefore: Date,
    limit: number,
  ): Promise<Pick<Trip, 'id' | 'status' | 'passengerId' | 'driverId' | 'updatedAt'>[]> {
    return this.prisma.read.trip.findMany({
      where: { status: { in: [...WATCHED_STATES] }, updatedAt: { lte: staleBefore } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, status: true, passengerId: true, driverId: true, updatedAt: true },
    });
  }

  /**
   * Lleva UN viaje estancado a su terminal de fallo (EXPIRED pre-recojo / FAILED en curso) en UNA
   * transacción: status + trip_event + outbox (trip.expired | trip.failed) para que downstream
   * reaccione (notificar al pasajero; payment anula/omite cobro). La invoca el TripWatchdogScheduler.
   *
   * IDEMPOTENTE y seguro ante carreras: relee el viaje, recalcula el target con el reloj actual y usa
   * un updateMany con guard `where status = <estado observado>`. Si otro tick/endpoint ya lo movió
   * (count 0) no hace nada. Devuelve el terminal aplicado, o null si no se transicionó.
   */
  async sweepStalledTrip(
    id: string,
    thresholds: WatchdogThresholds,
    now: Date = new Date(),
  ): Promise<StalledTarget | null> {
    const trip = await this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true, passengerId: true, driverId: true, updatedAt: true },
    });
    if (!trip) return null;
    const target = resolveStalledTarget(trip.status, trip.updatedAt, now, thresholds);
    if (target === null) return null; // ya no estancado / ya terminal / aún fresco
    assertTransition(trip.status, target); // la guarda ya permite estos → EXPIRED/FAILED

    const staleMinutes = Math.floor((now.getTime() - trip.updatedAt.getTime()) / 60000);
    const eventType = target === TripStatus.EXPIRED ? 'trip.expired' : 'trip.failed';

    const applied = await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera: solo transiciona si SIGUE en el estado observado (no doble barrido ni
      // pisar una transición legítima — accept/cancel/complete — que ocurrió entre el read y aquí).
      const updated = await tx.trip.updateMany({
        where: { id, status: trip.status },
        data:
          target === TripStatus.EXPIRED
            ? { status: TripStatus.EXPIRED }
            : { status: TripStatus.FAILED },
      });
      if (updated.count === 0) return false; // otro actor ganó la carrera

      const payload = {
        tripId: id,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: trip.driverId ?? undefined,
        staleMinutes,
        at: now.toISOString(),
      };
      await this.recordEvent(tx, id, eventType, payload);
      await enqueueOutbox(
        tx,
        createEnvelope({ eventType, producer: PRODUCER, payload }),
        id,
      );
      return true;
    });

    if (!applied) return null;
    this.logger.log(`watchdog: viaje ${id} ${trip.status} → ${target} (estancado ${staleMinutes} min)`);
    return target;
  }

  // ───────────────────────────── Transiciones ─────────────────────────────

  /** POST /trips/:id/assign — asigna conductor/vehículo. Emite trip.assigned. */
  async assignDriver(id: string, dto: AssignTripDto): Promise<TripView> {
    return this.assign(id, dto.driverId, dto.vehicleId);
  }

  /**
   * Asignación disparada por dispatch.match_found (consumidor Kafka). El evento de dispatch no
   * transporta vehicleId, por lo que se asigna solo el conductor (vehicleId se confirma al aceptar).
   * Idempotente: si el viaje ya está ASSIGNED con ese conductor, no hace nada.
   */
  async assignFromDispatch(id: string, driverId: string): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id } });
    if (!trip) {
      this.logger.warn(`dispatch.match_found para viaje inexistente ${id}; ignorado`);
      return;
    }
    if (trip.status === TripStatus.ASSIGNED && trip.driverId === driverId) return; // idempotente
    // N10 — tolerancia a un viaje que YA NO es asignable: un match_found puede re-emitirse desde el board
    // de Redis (reconciler de dispatch / redelivery at-least-once) DESPUÉS de que el viaje dejó de poder
    // recibir ASSIGNED — porque murió (CANCELLED_BY_*/FAILED/COMPLETED) o porque la puja se cerró sin match
    // (EXPIRED) o avanzó a otra rama. dispatch es cross-service y NO conoce el status del trip. Materializar
    // ASSIGNED desde cualquiera de esos estados es IMPOSIBLE: assertTransition lanza InvalidTripTransition.
    // Ese error es PERMANENTE (la máquina de estados lo prohíbe siempre, no es transitorio): si lo dejáramos
    // propagar, el consumer Kafka haría no-ack → retry INFINITO (poison-loop, consumer trabado). El match es
    // MOOT → lo tratamos como no-op NO reintentable (no lanzamos → el consumer ACK-ea). SOLO los errores
    // genuinamente transitorios (DB caída, etc.) — que NO son InvalidTripTransition — siguen propagando para
    // que el consumer reintente. Capturar el error de `assign` (en vez de pre-chequear) cubre además la
    // carrera en que el viaje cae a un estado no-asignable ENTRE el read de arriba y el assertTransition.
    try {
      await this.assign(id, driverId, null);
    } catch (err) {
      if (err instanceof InvalidTripTransition) {
        this.logger.warn(
          `dispatch.match_found para viaje ${id} en estado ${trip.status}: no asignable; ignorado (match moot, ACK)`,
        );
        return;
      }
      throw err; // error transitorio (DB caída, etc.) → re-lanza para que el consumer reintente
    }
  }

  private async assign(id: string, driverId: string, vehicleId: string | null): Promise<TripView> {
    // GUARD ATÓMICO (no check-then-act): el estado va en el WHERE del updateMany, así el viaje se mueve a
    // ASSIGNED en el MISMO statement que valida que era asignable. Dos `dispatch.match_found` concurrentes
    // con DISTINTO conductor (dos réplicas del trip-service) → solo UNO matchea un estado asignable y gana
    // el claim; el otro ve count=0 → InvalidTripTransition (moot → assignFromDispatch lo ACK-ea). Antes era
    // read → assertTransition(status leído) → update({where:{id}}) incondicional: dos asignaciones podían
    // pisarse (last-write-wins = doble conductor a un pasajero). Hoy Kafka serializa por tripId (key del
    // outbox), pero NO dependemos de ese supuesto: el viaje es la autoridad atómica de "quién quedó asignado".
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const claim = await tx.trip.updateMany({
        where: { id, status: { in: transitionSources(TripStatus.ASSIGNED) } },
        data: { status: TripStatus.ASSIGNED, driverId, vehicleId, assignedAt: new Date() },
      });
      if (claim.count === 0) {
        // No se movió: el viaje no existe, o no estaba en un estado asignable (ya ASSIGNED a otro,
        // cancelado, etc.). Releemos para un error honesto con el `from` real.
        const current = await tx.trip.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('Viaje no encontrado', { id });
        // Estado no-asignable → InvalidTripTransition (permanente; assignFromDispatch lo trata como moot/ACK).
        throw new InvalidTripTransition(current.status, TripStatus.ASSIGNED);
      }
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await this.recordEvent(tx, id, 'trip.assigned', { driverId, vehicleId });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.assigned',
          producer: PRODUCER,
          payload: { tripId: id, driverId, vehicleId: vehicleId ?? '' },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /** POST /trips/:id/accept — el conductor acepta. Emite trip.accepted. */
  async acceptTrip(id: string, dto: AcceptTripDto): Promise<TripView> {
    const trip = await this.mustFind(id);
    assertTransition(trip.status, TripStatus.ACCEPTED);
    const etaSeconds = dto.etaSeconds ?? 300;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: { status: TripStatus.ACCEPTED, acceptedAt: new Date() },
      });
      await this.recordEvent(tx, id, 'trip.accepted', { driverId: trip.driverId, etaSeconds });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.accepted',
          producer: PRODUCER,
          // passengerId ENRIQUECIDO: notification-service resuelve el token del pasajero (push "tu
          // conductor confirmó") sin un join cross-servicio.
          payload: { tripId: id, driverId: this.requireDriver(trip), etaSeconds, passengerId: trip.passengerId },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /** POST /trips/:id/arriving — el conductor va en camino. Emite trip.arriving. */
  async arriving(id: string, dto: ArrivingTripDto): Promise<TripView> {
    const trip = await this.mustFind(id);
    assertTransition(trip.status, TripStatus.ARRIVING);
    const etaSeconds = dto.etaSeconds ?? 120;
    const at = new Date();

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: { status: TripStatus.ARRIVING, arrivingAt: at },
      });
      await this.recordEvent(tx, id, 'trip.arriving', { etaSeconds });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.arriving',
          producer: PRODUCER,
          payload: {
            tripId: id,
            driverId: this.requireDriver(trip),
            etaSeconds,
            at: at.toISOString(),
            // passengerId ENRIQUECIDO: push "tu conductor está llegando" (el más importante del ride-hailing).
            passengerId: trip.passengerId,
          },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /** POST /trips/:id/arrived — el conductor llegó al punto de recojo. Emite trip.arrived. */
  async arrived(id: string): Promise<TripView> {
    const trip = await this.mustFind(id);
    assertTransition(trip.status, TripStatus.ARRIVED);
    const at = new Date();

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: { status: TripStatus.ARRIVED, arrivedAt: at },
      });
      await this.recordEvent(tx, id, 'trip.arrived', {});
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.arrived',
          producer: PRODUCER,
          // passengerId ENRIQUECIDO: push "tu conductor llegó". waitWindowSeconds NO se emite: el
          // dominio aún no modela una ventana de espera del conductor (gap honesto; el schema la soporta
          // como opcional para cuando exista, y el consumidor la incluye en el push solo si viaja).
          payload: { tripId: id, driverId: this.requireDriver(trip), at: at.toISOString(), passengerId: trip.passengerId },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * POST /trips/:id/start — inicia el viaje. Si es modo niño (BR-T07), valida el código:
   * un código incorrecto NO avanza a IN_PROGRESS; registra evento y publica alerta.
   * Emite trip.started en el camino feliz.
   */
  async start(id: string, dto: StartTripDto): Promise<TripView> {
    const trip = await this.mustFind(id);

    // A1 · ownership server-side (anti-IDOR, defensa en profundidad junto al gate del driver-bff): solo
    // el conductor ASIGNADO inicia (y prueba el código de modo niño de) SU viaje. El driver-bff DERIVA el
    // driverId del perfil (GetDriverByUser → driver.id) y lo manda; trip-service lo verifica aquí. 404 (no
    // 403) para no filtrar la existencia de un viaje ajeno. Solo valida SI viene driverId (callers legacy
    // que no lo envían siguen andando — mismo criterio que cancel con passengerId).
    if (dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }

    assertTransition(trip.status, TripStatus.IN_PROGRESS);

    if (trip.childMode) {
      // B · lockout anti-brute-force: si el viaje ya está bloqueado por demasiados intentos fallidos,
      // rechazamos ANTES de comparar el código (429). El candado expira solo (TTL Redis de 15 min).
      if (await this.isChildCodeLocked(id)) {
        throw new RateLimitError(
          'Demasiados intentos con el código de modo niño; intentá de nuevo en unos minutos (BR-T07)',
          { tripId: id },
        );
      }

      if (!dto.childCode) {
        throw new ValidationError('Este viaje requiere el código de modo niño para iniciar (BR-T07)');
      }
      const ok = trip.childCodeHash
        ? bcrypt.compareSync(dto.childCode, trip.childCodeHash)
        : false;
      if (!ok) {
        // B · registra el intento fallido (atómico) y, si alcanza el tope, echa el candado de 15 min.
        await this.registerChildCodeFailure(id);
        await this.prisma.write.$transaction(async (tx) => {
          await this.recordEvent(tx, id, 'trip.child_code_failed', { at: new Date().toISOString() });
          await enqueueOutbox(
            tx,
            createEnvelope({
              eventType: 'trip.child_code_failed',
              producer: PRODUCER,
              payload: {
                tripId: id,
                passengerId: trip.passengerId,
                driverId: trip.driverId,
                at: new Date().toISOString(),
              },
            }),
            id,
          );
        });
        throw new ValidationError('Código de modo niño incorrecto; el viaje no puede iniciar (BR-T07)');
      }
      // B · código correcto → resetea contador y candado (Redis): el viaje pudo iniciar limpio.
      await this.resetChildCodeAttempts(id);
    }

    const startedAt = new Date();
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: { status: TripStatus.IN_PROGRESS, startedAt },
      });
      await this.recordEvent(tx, id, 'trip.started', { startedAt: startedAt.toISOString() });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.started',
          producer: PRODUCER,
          payload: {
            tripId: id,
            driverId: this.requireDriver(trip),
            startedAt: startedAt.toISOString(),
            // passengerId ENRIQUECIDO: push "tu viaje empezó" (dispara el dominó de compartir/familia).
            passengerId: trip.passengerId,
          },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * B · ¿el código de modo niño de este viaje está bloqueado? Si no hay Redis (tests legacy), nunca
   * bloquea (degradación honesta al comportamiento previo).
   */
  private async isChildCodeLocked(tripId: string): Promise<boolean> {
    if (!this.redis) return false;
    return (await this.redis.get(childCodeLockKey(tripId))) !== null;
  }

  /**
   * B · registra UN intento fallido del código de modo niño (atómico vía INCR). En el PRIMER intento
   * arma la ventana de 15 min (EXPIRE) para que el contador se auto-limpie. Al alcanzar el tope (5)
   * echa el candado de 15 min (EX 900). INCR es atómico ⇒ robusto a reintentos concurrentes; el último
   * que cruza el umbral setea el lock (idempotente: re-setearlo solo refresca el mismo TTL).
   */
  private async registerChildCodeFailure(tripId: string): Promise<void> {
    if (!this.redis) return;
    const attempts = await this.redis.incr(childCodeAttemptsKey(tripId));
    if (attempts === 1) {
      // primer fallo de la ventana → arma el TTL del contador (se auto-resetea si no se llega al tope).
      await this.redis.expire(childCodeAttemptsKey(tripId), CHILD_CODE_LOCK_SECONDS);
    }
    if (attempts >= CHILD_CODE_MAX_ATTEMPTS) {
      await this.redis.set(childCodeLockKey(tripId), '1', 'EX', CHILD_CODE_LOCK_SECONDS);
    }
  }

  /** B · acierto del código → borra contador y candado (reset al iniciar limpio). */
  private async resetChildCodeAttempts(tripId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(childCodeAttemptsKey(tripId), childCodeLockKey(tripId));
  }

  /**
   * POST /trips/:id/complete — finaliza el viaje. Emite trip.completed.
   *
   * EFECTIVO (decisión del dueño): `dto.cashCollected` es la señal del CONDUCTOR de que cobró el
   * efectivo en mano al terminar (driverConfirmed del modelo bilateral, BR-P03). Viaja en el evento
   * SOLO si el viaje es CASH (en digital se ignora: el cobro va por el riel). Así payment-service crea
   * la CashConfirmation con driverConfirmed=true de una y el CASH se captura cuando el pasajero confirma
   * (NUNCA queda pending colgado). El driverId lo deriva el driver-bff (anti-IDOR); acá se verifica.
   */
  async complete(id: string, dto: CompleteTripDto = {}): Promise<TripView> {
    const trip = await this.mustFind(id);

    // A1 · ownership server-side (anti-IDOR, defensa en profundidad junto al gate del driver-bff): solo
    // el conductor ASIGNADO da por terminado SU viaje. El driver-bff DERIVA el driverId del perfil y lo
    // manda; acá se verifica. 404 (no 403) para no filtrar la existencia ajena. Solo valida SI viene
    // driverId (callers legacy que no lo envían siguen andando — mismo criterio que start/cancel).
    if (dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }

    assertTransition(trip.status, TripStatus.COMPLETED);
    const completedAt = new Date();

    // Solo propagamos cashCollected si el viaje es CASH (en digital es ruido: el cobro va por el riel).
    // `?? undefined` para que un flag ausente NO viaje como `false` (preserva la compat N-2 del schema).
    const cashCollected =
      trip.paymentMethod === 'CASH' ? (dto.cashCollected ?? undefined) : undefined;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: { status: TripStatus.COMPLETED, completedAt },
      });
      await this.recordEvent(tx, id, 'trip.completed', { fareCents: trip.fareCents });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.completed',
          producer: PRODUCER,
          payload: {
            tripId: id,
            fareCents: trip.fareCents,
            distanceMeters: trip.distanceMeters,
            durationSeconds: trip.durationSeconds,
            // passengerId habilita la recompensa de referidos (identity) y promoCode el canje (payment).
            passengerId: trip.passengerId,
            driverId: trip.driverId ?? undefined,
            paymentMethod: trip.paymentMethod,
            promoCode: trip.promoCode ?? undefined,
            // EFECTIVO: "el conductor cobró en mano" → payment crea CashConfirmation driverConfirmed=true.
            cashCollected,
          },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * POST /trips/:id/cancel — cancela el viaje y calcula penalización (BR-T03). Emite trip.cancelled.
   *
   * PUJA (ADR 010 #4): si el CONDUCTOR cancela DESPUÉS de aceptar (ACCEPTED/ARRIVING/ARRIVED), el
   * viaje NO termina — se reasigna (→ REASSIGNING, emite trip.reassigning, re-abre la puja). El
   * cancel del conductor PRE-accept (desde ASSIGNED) y el cancel del pasajero siguen siendo terminales.
   */
  async cancel(id: string, dto: CancelTripDto): Promise<TripView> {
    const trip = await this.mustFind(id);

    // A1 · ownership server-side (anti-IDOR, defensa en profundidad junto al gate del BFF): un pasajero
    // solo cancela SU viaje. 404 (no 403) para no filtrar la existencia de un viaje ajeno. La cancelación
    // por el CONDUCTOR no manda passengerId (su ownership es por driverId, lo enforce su propio BFF).
    if (dto.by === 'PASSENGER' && dto.passengerId && trip.passengerId !== dto.passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }

    if (dto.by === 'DRIVER' && POST_ACCEPT_STATES.has(trip.status)) {
      return this.reassignAfterDriverCancel(trip, dto.reason);
    }

    const target =
      dto.by === 'PASSENGER'
        ? TripStatus.CANCELLED_BY_PASSENGER
        : TripStatus.CANCELLED_BY_DRIVER;
    assertTransition(trip.status, target);

    const now = new Date();
    const driverEta = this.estimateDriverEta(trip);
    const penaltyCents = calculateCancellationPenalty({
      by: dto.by,
      assignedAt: trip.assignedAt,
      driverEta,
      now,
    });

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: {
          status: target,
          cancelledAt: now,
          cancelledBy: dto.by,
          cancellationReason: dto.reason ?? null,
          penaltyCents,
        },
      });
      await this.recordEvent(tx, id, 'trip.cancelled', { by: dto.by, penaltyCents, reason: dto.reason });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.cancelled',
          producer: PRODUCER,
          // passengerId ENRIQUECIDO: notification-service confirma HONESTO al pasajero ("cancelaste tu
          // viaje" si by=PASSENGER; "tu conductor canceló" si by=DRIVER pre-recojo). El cancel del
          // conductor POST-accept va por la rama reassignAfterDriverCancel (emite trip.reassigning, no
          // trip.cancelled) → sin solapamiento de pushes.
          // driverId ENRIQUECIDO (F2): si había conductor asignado, payment-service le compensa su parte
          // del split de la penalidad (esperó). Ausente → la penalidad va entera a la plataforma.
          payload: {
            tripId: id,
            by: dto.by,
            reason: dto.reason,
            penaltyCents,
            passengerId: trip.passengerId,
            driverId: trip.driverId ?? undefined,
          },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * PUJA (ADR 010 #4) · el conductor canceló DESPUÉS de aceptar (pre-recojo): el viaje pasa a
   * REASSIGNING y emitimos trip.reassigning para que dispatch RE-ABRA el OfferBoard (misma transacción,
   * outbox). Cierra el catastrófico #4 (pasajero abandonado). El conductor que canceló se desvincula
   * (driverId → null) para que el re-match pueda asignar a otro.
   *
   * ROBUSTEZ #4 (anti bucle infinito): incrementamos `reassignCount` y, si supera el tope (TRIP_MAX_REASSIGN,
   * default 3), NO re-pujamos más — el viaje cae a un terminal HONESTO (FAILED, único terminal alcanzable
   * desde ACCEPTED/ARRIVING/ARRIVED en la máquina de estados) y emitimos trip.failed para que el pasajero
   * reciba la notificación con una razón (callejón sin salida explícito, no un viaje atascado para siempre).
   *
   * El evento `trip.reassigning` va ENRIQUECIDO (driverId del que canceló, passengerId, vehicleType, origin)
   * para que dispatch RECONSTRUYA el board sin depender de la key vieja de Redis (que pudo expirar por TTL)
   * y LIBERE al conductor que canceló (estaba markBusy). `bidCents` = el bid actual del viaje (`fareCents`).
   *
   * DECISIÓN #4 "subir al re-abrir" (H6.4 · honestidad): esta reasignación AUTOMÁTICA re-abre la puja al
   * bid VIEJO de inmediato (mismo `fareCents`), NO sube sola. El pasajero SUBE el precio con una acción
   * EXPLÍCITA: `POST /trips/:id/rebid` (método `rebid`), que lo vuelve a REQUESTED y abre un board fresco al
   * nuevo bid. Así el pasajero abandonado tiene continuidad inmediata (board al precio actual) Y la opción
   * de mejorar la oferta si nadie acepta.
   */
  private async reassignAfterDriverCancel(trip: Trip, reason?: string): Promise<TripView> {
    const nextReassignCount = trip.reassignCount + 1;

    // Tope superado: NO se re-despacha más (anti bucle infinito). Terminal honesto FAILED + notificación.
    // Aplica a AMBOS modos (un viaje FIXED cuyo conductor cancela en bucle tampoco debe colgarse).
    if (nextReassignCount > this.maxReassign) {
      return this.failAfterTooManyReassigns(trip, nextReassignCount);
    }

    // ADR 011 §1.2/§4 · resolve-once: la reasignación respeta el modo CONGELADO del viaje, NO re-resuelve
    // de la config admin actual (un flip de config a media-vida NO debe re-abrir una puja bajo política
    // fija, ni al revés). FIXED → re-despacha el flujo de tarifa fija (trip.requested → matching
    // secuencial). PUJA → re-abre el OfferBoard como hasta hoy.
    if (trip.dispatchMode === PricingMode.FIXED) {
      return this.reassignFixedTrip(trip, nextReassignCount, reason);
    }

    assertTransition(trip.status, TripStatus.REASSIGNING);
    const bidCents = trip.fareCents;
    const cancelledDriverId = trip.driverId;
    // H13 — re-abrir la negociación = NUEVO ciclo: incrementa el seq MONOTÓNICO (NUNCA resetea). El board
    // re-abierto y su offer_accepted viajarán con este seq, y un offer_accepted STALE del ciclo anterior
    // (seq menor) que se redelivere quedará bloqueado en applyAgreedFare (where no matchea → no-op).
    const nextNegotiationSeq = trip.negotiationSeq + 1;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.REASSIGNING,
          // El conductor que canceló se desvincula: el re-match elegirá a otro. Sin penalización al
          // pasajero (no canceló él); la penalización al conductor se modela en su propio dominio.
          driverId: null,
          // H12: re-abrir la negociación = NUEVA decisión de dinero. Reseteamos el guard once-ever de
          // applyAgreedFare (agreedFareCents) para que el offer_accepted del re-match aplique el precio
          // FRESCO en vez de ser bloqueado por el agreed-fare de la negociación anterior (conductor mal pagado).
          agreedFareCents: null,
          reassignCount: nextReassignCount,
          // H13 — bump del sello de ciclo en la MISMA tx que el reset del agreedFareCents.
          negotiationSeq: nextNegotiationSeq,
          cancellationReason: reason ?? 'driver_cancelled',
        },
      });
      await this.recordEvent(tx, trip.id, 'trip.reassigning', {
        from: trip.status,
        previousDriverId: cancelledDriverId,
        reassignCount: nextReassignCount,
        bidCents,
        negotiationSeq: nextNegotiationSeq,
        reason: 'driver_cancelled',
      });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.reassigning',
          producer: PRODUCER,
          payload: {
            tripId: trip.id,
            // El conductor que canceló: dispatch lo LIBERA del hot-index (vuelve a ser elegible).
            driverId: cancelledDriverId ?? '',
            passengerId: trip.passengerId,
            vehicleType: trip.vehicleType,
            origin: { lat: trip.originLat, lon: trip.originLon },
            bidCents,
            reason: 'driver_cancelled',
            // H13 — dispatch persiste este seq en el board re-abierto y lo estampa en offer_accepted.
            negotiationSeq: nextNegotiationSeq,
          },
        }),
        trip.id,
      );
      return next;
    });
    this.logger.log(
      `PUJA: viaje ${trip.id} ${trip.status} → REASSIGNING (conductor ${cancelledDriverId} canceló; ` +
        `re-abre puja a ${bidCents}; reasignación ${nextReassignCount}/${this.maxReassign})`,
    );
    return toTripView(updated);
  }

  /**
   * ADR 011 §1.2/§4 · reasignación de un viaje FIXED tras cancelación del conductor post-accept (espejo
   * FIXED de reassignAfterDriverCancel). El viaje NO re-abre una puja (es precio fijo): pasa por
   * REASSIGNING (estado de "buscando otro conductor", REASSIGNING → ASSIGNED es válido para el re-match)
   * y re-emite `trip.requested` para re-disparar el matching SECUENCIAL de tarifa fija. El conductor que
   * canceló se desvincula (driverId → null). La tarifa fija (fareCents) NO cambia (BR-T01 inmutable);
   * NO se toca negotiationSeq/agreedFareCents (son del dominio puja, irrelevantes en FIXED).
   */
  private async reassignFixedTrip(
    trip: Trip,
    nextReassignCount: number,
    reason?: string,
  ): Promise<TripView> {
    assertTransition(trip.status, TripStatus.REASSIGNING);
    const cancelledDriverId = trip.driverId;
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.REASSIGNING,
          driverId: null,
          reassignCount: nextReassignCount,
          cancellationReason: reason ?? 'driver_cancelled',
        },
      });
      // Re-despacho FIXED: el mismo evento que la creación de un viaje de tarifa fija (trip.requested),
      // para que dispatch re-arranque el matching secuencial. emitTripRequested lee origin/destination
      // del trip recién actualizado (status REASSIGNING, driverId null).
      await this.emitTripRequested(tx, next, origin, destination);
      return next;
    });
    this.logger.log(
      `FIXED: viaje ${trip.id} ${trip.status} → REASSIGNING (conductor ${cancelledDriverId} canceló; ` +
        `re-despacha tarifa fija ${trip.fareCents}; reasignación ${nextReassignCount}/${this.maxReassign})`,
    );
    return toTripView(updated);
  }

  /**
   * ROBUSTEZ #4 · tope de re-asignaciones superado: el viaje NO puede seguir re-pujando (sería un bucle
   * infinito de cancelaciones). Lo llevamos al terminal FAILED (único terminal alcanzable desde los
   * estados post-accept en la máquina de estados) y emitimos trip.failed para que el pasajero reciba la
   * notificación HONESTA del callejón sin salida. `staleMinutes` 0 (no es estancamiento del watchdog: es
   * un tope de negocio); el conductor que canceló se desvincula igual.
   */
  private async failAfterTooManyReassigns(trip: Trip, reassignCount: number): Promise<TripView> {
    assertTransition(trip.status, TripStatus.FAILED);
    const at = new Date();
    const cancelledDriverId = trip.driverId;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.FAILED,
          driverId: null,
          reassignCount,
          cancelledAt: at,
          cancellationReason: 'max_reassign_exceeded',
        },
      });
      const payload = {
        tripId: trip.id,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: cancelledDriverId ?? undefined,
        staleMinutes: 0,
        at: at.toISOString(),
      };
      await this.recordEvent(tx, trip.id, 'trip.failed', {
        ...payload,
        reason: 'max_reassign_exceeded',
        reassignCount,
      });
      await enqueueOutbox(
        tx,
        createEnvelope({ eventType: 'trip.failed', producer: PRODUCER, payload }),
        trip.id,
      );
      return next;
    });
    this.logger.warn(
      `PUJA: viaje ${trip.id} ${trip.status} → FAILED (tope de re-asignaciones ${reassignCount} > ` +
        `${this.maxReassign}; pasajero notificado, no más re-puja)`,
    );
    return toTripView(updated);
  }

  /**
   * Consumidor de `dispatch.offer_accepted` (ADR 010 §4): el pasajero eligió la oferta de un conductor;
   * el `priceCents` ACORDADO pasa a ser el `fareCents` del viaje (puede DIFERIR del bid original si el
   * pasajero aceptó un COUNTER). NO transiciona el estado: el ASSIGNED lo materializa el consumidor de
   * `dispatch.match_found` (dispatch emite AMBOS en la misma tx de outbox; el orden de llegada no importa
   * porque este método solo escribe el precio y assignFromDispatch solo el estado/driver — son disjuntos).
   *
   * IDEMPOTENTE POR EVENTO (N7), no por valor. El KafkaEventConsumer es at-least-once y NO tiene un
   * dedup-store propio, así que `dispatch.offer_accepted` puede REDELIVERSE. El viejo guard "si
   * fareCents ya == priceCents → no-op" era inseguro: tras aceptar un COUNTER (fare=900) y luego un
   * `changeDestination` que recalcula la tarifa (fare=1200), una redelivery del offer_accepted VIEJO
   * (900) veía 1200≠900 y SOBREESCRIBÍA la tarifa de vuelta a 900 (lost update / corrupción de tarifa).
   * Ahora marcamos `agreedFareCents` la PRIMERA vez que se aplica; si ya está marcado, es no-op
   * absoluto — sin importar cuánto haya cambiado `fareCents` por un `changeDestination` legítimo
   * posterior. El changeDestination NO se bloquea: es otra operación (recalcula fareCents directamente
   * y no toca agreedFareCents).
   */
  async applyAgreedFare(tripId: string, priceCents: number, negotiationSeq: number): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id: tripId } });
    if (!trip) {
      this.logger.warn(`dispatch.offer_accepted para viaje inexistente ${tripId}; ignorado`);
      return;
    }
    // H13 — guard de CICLO de negociación (cierra el residual money-path LOW): el offer_accepted lleva el
    // seq del ciclo que lo produjo. Si NO coincide con el seq vigente del viaje, es una redelivery STALE
    // de un ciclo VIEJO (p.ej. el match@900 del ciclo 1 redelivered DESPUÉS de que la reasignación llevó
    // el viaje al ciclo 2): NO debe escribir la tarifa rancia. Read-guard de corto-circuito; la garantía
    // dura la da el `where` atómico de abajo (negotiationSeq en el updateMany). Un seq menor (ciclo viejo)
    // o mayor (imposible, dispatch nunca adelanta el seq del board) → no-op.
    if (trip.negotiationSeq !== negotiationSeq) {
      this.logger.debug(
        `PUJA: viaje ${tripId} offer_accepted de ciclo ${negotiationSeq} ≠ ciclo vigente ${trip.negotiationSeq}; ` +
          `redelivery STALE ignorada (no escribe tarifa rancia)`,
      );
      return;
    }
    // Guard idempotente-por-EVENTO: si el precio acordado ya se aplicó UNA vez, toda redelivery del
    // offer_accepted (incluso una stale, tras un changeDestination) es no-op. Esto cierra el lost-update.
    if (trip.agreedFareCents !== null) {
      this.logger.debug(
        `PUJA: viaje ${tripId} precio acordado ya aplicado (${trip.agreedFareCents}); offer_accepted redelivery ignorado`,
      );
      return;
    }

    // Defensa en profundidad (gate de dinero): el precio acordado YA debería venir capado (dispatch
    // valida el COUNTER ≤ techo), pero la escritura de la tarifa NUNCA debe exceder el techo — un
    // priceCents desbocado overflowearía el int4 de fareCents. Rechazamos antes de escribir.
    if (priceCents > this.bidMaxCents) {
      throw new ValidationError(
        `El precio acordado (${priceCents}) supera el techo permitido (${this.bidMaxCents}) (ADR 010)`,
        { tripId, priceCents, maxCents: this.bidMaxCents },
      );
    }

    const applied = await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera atómico + N9 guard de estado: solo aplica si agreedFareCents SIGUE null (otra
      // redelivery concurrente pudo aplicarlo entre el read y este update) Y el viaje NO está en un
      // terminal. Sin el status-guard, un offer_accepted tardío/duplicado escribiría fareCents +
      // trip.fare_agreed sobre un viaje ya CANCELLED/EXPIRED/FAILED/COMPLETED (espejo de
      // expireFromNoOffers, que también status-guardea su updateMany). count 0 → ya terminal o ya
      // aplicado → no-op idempotente.
      const result = await tx.trip.updateMany({
        // H13 — el `negotiationSeq` del CICLO vigente es parte de la condición ATÓMICA: una redelivery
        // STALE de un ciclo viejo (seq menor) NO matchea esta fila → count 0 → no-op (no escribe la
        // tarifa rancia del conductor del ciclo anterior). Convive con el guard once-ever (agreedFareCents
        // null = dedup de redelivery DENTRO del ciclo) y el status-guard (no escribir sobre un terminal).
        where: {
          id: tripId,
          negotiationSeq,
          agreedFareCents: null,
          status: { in: [...FARE_APPLICABLE_STATES] },
        },
        data: { fareCents: priceCents, agreedFareCents: priceCents },
      });
      if (result.count === 0) return false;
      await this.recordEvent(tx, tripId, 'trip.fare_agreed', {
        previousFareCents: trip.fareCents,
        fareCents: priceCents,
      });
      return true;
    });
    if (!applied) {
      this.logger.warn(
        `PUJA: viaje ${tripId} en estado ${trip.status}; offer_accepted ignorado (terminal o ya aplicado)`,
      );
      return;
    }
    this.logger.log(`PUJA: viaje ${tripId} fareCents ${trip.fareCents} → ${priceCents} (precio acordado)`);
  }

  /**
   * Consumidor de `dispatch.no_offers` (ADR 010 §4/§5): la puja cerró sin match → el viaje pasa a
   * EXPIRED y emite trip.expired para que el pasajero reciba la notificación (pantalla NoOffers y
   * re-puja). Subsume el viejo dispatch.timeout (#5). Idempotente y seguro ante carreras: solo
   * transiciona desde un estado de puja abierta (REQUESTED/REASSIGNING) con guard updateMany.
   */
  async expireFromNoOffers(tripId: string, reason: string): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id: tripId } });
    if (!trip) {
      this.logger.warn(`dispatch.no_offers para viaje inexistente ${tripId}; ignorado`);
      return;
    }
    // Solo expira una puja ABIERTA (REQUESTED = puja inicial, REASSIGNING = re-puja). Si el viaje ya
    // avanzó (match aceptado, cancelado, etc.) el no_offers es tardío/duplicado → no-op idempotente.
    if (trip.status !== TripStatus.REQUESTED && trip.status !== TripStatus.REASSIGNING) {
      this.logger.warn(
        `dispatch.no_offers para viaje ${tripId} en estado ${trip.status}; ignorado (puja ya cerrada)`,
      );
      return;
    }
    assertTransition(trip.status, TripStatus.EXPIRED);
    const at = new Date();

    await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera: solo expira si SIGUE en el estado de puja observado.
      const result = await tx.trip.updateMany({
        where: { id: tripId, status: trip.status },
        data: { status: TripStatus.EXPIRED },
      });
      if (result.count === 0) return; // otro actor ganó la carrera (match/cancel) → no-op

      const payload = {
        tripId,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: trip.driverId ?? undefined,
        // No es un estancamiento del watchdog: la ventana de puja venció. staleMinutes 0 (semántica:
        // expiración inmediata por no_offers, no por antigüedad). reason conserva la causa de dispatch.
        staleMinutes: 0,
        at: at.toISOString(),
      };
      await this.recordEvent(tx, tripId, 'trip.expired', { ...payload, reason });
      await enqueueOutbox(
        tx,
        createEnvelope({ eventType: 'trip.expired', producer: PRODUCER, payload }),
        tripId,
      );
    });
    this.logger.log(`PUJA: viaje ${tripId} ${trip.status} → EXPIRED (no_offers: ${reason})`);
  }

  /**
   * Consumidor de `dispatch.bid_cancelled` (FIX puja-cancel): el PASAJERO canceló la PUJA (`POST
   * /trips/:id/bid/cancel` → dispatch cerró el board y emitió este cierre por outbox). Cierra el VIAJE —
   * REQUESTED/REASSIGNING → CANCELLED_BY_PASSENGER — no solo el board efímero. Espejo de
   * `expireFromNoOffers`, pero el terminal es CANCELLED_BY_PASSENGER (lo eligió el pasajero), no EXPIRED.
   *
   * Cierra el zombie: hasta hoy el cancel SOLO marcaba el board CANCELLED en Redis y el trip quedaba
   * REQUESTED hasta el watchdog (~10min) → single-live-trip bloqueaba re-pedir y los accepts caían 409/404.
   *
   * IDEMPOTENTE + seguro ante carreras (mismo patrón que expireFromNoOffers):
   *  - Solo transiciona desde un estado de PUJA abierta (REQUESTED = puja inicial, REASSIGNING = re-puja).
   *    Si el viaje ya avanzó (match aceptado, ya cancelado, completado…) → no-op (cancel tardío/repetido).
   *  - Guard de carrera con `updateMany where status` (solo escribe si SIGUE en el estado observado).
   *  - Cubre el caso "cancelo a los 95s, el board ya murió por TTL": dispatch emite igual el cierre y acá
   *    el trip REQUESTED se cierra de todas formas.
   *  - Emite `trip.cancelled` (by PASSENGER, sin penalidad — es una puja, aún no hubo conductor en camino)
   *    para que dispatch libere cualquier residual y payment/downstream reaccionen, igual que el cancel normal.
   */
  async cancelFromBid(tripId: string): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id: tripId } });
    if (!trip) {
      this.logger.warn(`dispatch.bid_cancelled para viaje inexistente ${tripId}; ignorado`);
      return;
    }
    if (trip.status !== TripStatus.REQUESTED && trip.status !== TripStatus.REASSIGNING) {
      this.logger.warn(
        `dispatch.bid_cancelled para viaje ${tripId} en estado ${trip.status}; ignorado (puja ya cerrada)`,
      );
      return;
    }
    assertTransition(trip.status, TripStatus.CANCELLED_BY_PASSENGER);
    const now = new Date();

    await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera: solo cancela si SIGUE en el estado de puja observado (otro actor —match/expire—
      // pudo ganar la carrera entre el read y este update).
      const result = await tx.trip.updateMany({
        where: { id: tripId, status: trip.status },
        data: {
          status: TripStatus.CANCELLED_BY_PASSENGER,
          cancelledAt: now,
          cancelledBy: 'PASSENGER',
          cancellationReason: 'bid_cancelled',
          penaltyCents: 0, // sin penalidad: es una puja en curso, aún no hubo conductor en camino (BR-T03)
        },
      });
      if (result.count === 0) return; // otro actor ganó la carrera → no-op idempotente
      await this.recordEvent(tx, tripId, 'trip.cancelled', {
        by: 'PASSENGER',
        penaltyCents: 0,
        reason: 'bid_cancelled',
        fromStatus: trip.status,
      });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.cancelled',
          producer: PRODUCER,
          payload: { tripId, by: 'PASSENGER', reason: 'bid_cancelled', penaltyCents: 0, passengerId: trip.passengerId },
        }),
        tripId,
      );
    });
    this.logger.log(`PUJA: viaje ${tripId} ${trip.status} → CANCELLED_BY_PASSENGER (bid_cancelled)`);
  }

  /** Estados desde los que el pasajero puede RE-PUJAR (H6.4): puja muerta/estancada que reactivar. */
  private static readonly REBIDDABLE: ReadonlySet<TripStatus> = new Set([
    TripStatus.REASSIGNING, // re-match tras cancel del conductor: el pasajero sube el bid (decisión #4)
    TripStatus.EXPIRED, // sin ofertas: el pasajero reactiva en vez de crear un viaje nuevo (#12)
  ]);

  /**
   * POST /trips/:id/rebid — RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4). Cierra DOS gaps de una sola
   * vez: (#4) tras cancelar el conductor el viaje re-abre al bid VIEJO y el pasajero no tenía forma de
   * SUBIRLO; (#12) un viaje EXPIRED era callejón sin salida (había que crear otro). Aquí el pasajero
   * fija un NUEVO bid: el viaje vuelve a REQUESTED y emitimos `trip.bid_posted` → dispatch abre un board
   * FRESCO al nuevo precio (mismo camino que la puja inicial).
   *
   * REGLAS:
   *  - Solo desde REASSIGNING o EXPIRED (REBIDDABLE). Desde cualquier otro estado → ConflictError.
   *  - OWNERSHIP server-side: el pasajero solo re-puja SU viaje (passengerId del viaje == el del actor).
   *  - Bid en rango [floor(zona), techo]: se permite CUALQUIER valor del rango (no se FUERZA a subir).
   *    El re-bid SUELE ser para subir, pero no lo imponemos — regla más simple y sin sorpresas (la app
   *    sugiere subir; el dominio solo exige piso ≤ bid ≤ techo, igual que createTrip).
   *  - reassignCount → 0: una re-puja explícita REINICIA el ciclo de robustez #4 (es una puja fresca,
   *    no la continuación de la cadena de cancelaciones del conductor).
   *  - IDEMPOTENTE / seguro ante doble-tap: el cambio de estado va con guard `updateMany where status IN
   *    (REASSIGNING|EXPIRED)`. El segundo tap (ya REQUESTED) no encuentra fila → no re-emite bid_posted.
   */
  async rebid(tripId: string, passengerId: string, bidCents: number): Promise<TripView> {
    const trip = await this.mustFind(tripId);

    // Ownership server-side: no se filtra existencia de un viaje ajeno (mismo patrón que cancelScheduledTrip).
    if (trip.passengerId !== passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id: tripId });
    }

    if (!TripsService.REBIDDABLE.has(trip.status)) {
      throw new ConflictError('El viaje no admite re-puja en el estado actual (solo REASSIGNING/EXPIRED)', {
        status: trip.status,
      });
    }

    // Gate AUTORITATIVO de la puja (espeja createTrip): piso de zona ≤ bid ≤ techo (anti-overflow int4).
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const floor = this.resolveBidFloorCents(origin);
    if (bidCents < floor) {
      throw new ValidationError(
        `El bid (${bidCents}) es menor al piso de la zona (${floor}) (ADR 010 §9.3)`,
        { bidCents, floorCents: floor },
      );
    }
    if (bidCents > this.bidMaxCents) {
      throw new ValidationError(
        `El bid (${bidCents}) supera el techo permitido (${this.bidMaxCents}) (ADR 010)`,
        { bidCents, maxCents: this.bidMaxCents },
      );
    }

    const fromStatus = trip.status;
    assertTransition(fromStatus, TripStatus.REQUESTED);

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera/doble-tap: solo reactiva si SIGUE en el estado de puja muerta observado. Un
      // segundo tap (ya REQUESTED por el primero) no toca fila → no re-emite el board fresco.
      const guard = await tx.trip.updateMany({
        where: { id: tripId, status: fromStatus },
        data: {
          status: TripStatus.REQUESTED,
          fareCents: bidCents,
          // El conductor que pudo haber quedado colgado (REASSIGNING) se desvincula: board fresco, re-match limpio.
          driverId: null,
          // H12: re-puja explícita = NUEVA decisión de dinero. Reseteamos el guard once-ever de
          // applyAgreedFare (agreedFareCents) para que el offer_accepted del board fresco aplique el precio
          // recién acordado en vez de ser bloqueado por el agreed-fare del ciclo anterior (conductor mal pagado).
          agreedFareCents: null,
          // Re-puja explícita = ciclo fresco: reinicia el contador de robustez #4 (anti bucle infinito).
          reassignCount: 0,
          // H13 — re-puja = NUEVO ciclo de negociación: incrementa el seq MONOTÓNICO (a diferencia de
          // reassignCount, NUNCA resetea). El offer_accepted del board fresco viajará con este seq+1, y
          // un offer_accepted STALE del ciclo anterior (seq menor) quedará bloqueado en applyAgreedFare.
          negotiationSeq: trip.negotiationSeq + 1,
          requestedAt: new Date(),
        },
      });
      if (guard.count === 0) {
        // Otro tap ganó la carrera: idempotente, devolvemos el estado ya reactivado sin re-emitir.
        return null;
      }

      const reactivated: Trip = {
        ...trip,
        status: TripStatus.REQUESTED,
        fareCents: bidCents,
        driverId: null,
        reassignCount: 0,
        // H13 — espeja el incremento del updateMany para que emitBidPosted estampe el seq del nuevo ciclo.
        negotiationSeq: trip.negotiationSeq + 1,
      };
      await this.recordEvent(tx, tripId, 'trip.rebid', {
        from: fromStatus,
        previousBidCents: trip.fareCents,
        bidCents,
      });
      // Reusa el camino canónico de la puja: trip.bid_posted → dispatch abre un OfferBoard FRESCO al nuevo bid.
      await this.emitBidPosted(tx, reactivated, origin);
      return reactivated;
    });

    if (updated === null) {
      // Doble-tap: releemos el viaje ya reactivado (idempotente, no re-emitimos eventos).
      this.logger.log(`PUJA: re-bid duplicado de viaje ${tripId} (ya reactivado); no-op idempotente`);
      return toTripView(await this.mustFind(tripId));
    }

    this.logger.log(
      `PUJA: viaje ${tripId} ${fromStatus} → REQUESTED (re-bid del pasajero: ${trip.fareCents} → ${bidCents}; ` +
        `board fresco, reassignCount reiniciado)`,
    );
    return toTripView(updated);
  }

  /**
   * POST /trips/:id/destination — cambio de destino aprobado por el pasajero (BR-T01).
   * Recalcula y persiste la tarifa, registra trip_event. Solo antes de iniciar el viaje.
   */
  async changeDestination(id: string, dto: ChangeDestinationDto): Promise<TripView> {
    const trip = await this.mustFind(id);
    // A1 · ownership server-side (anti-IDOR): solo el pasajero dueño reescribe el destino. 404 no filtra.
    if (dto.passengerId && trip.passengerId !== dto.passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }
    if (!DESTINATION_EDITABLE.has(trip.status)) {
      throw new ConflictError('No se puede cambiar el destino en el estado actual', {
        status: trip.status,
      });
    }
    const destination = parseOrThrow(geoPointSchema, dto.destination, 'destination');
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    // Conserva las paradas múltiples (Ola 2B) ya elegidas al recalcular la ruta por cambio de destino.
    const waypoints = readWaypoints(trip);
    const route = await this.maps.route(origin, destination, waypoints);
    const surge = Number(trip.surgeMultiplier.toString());
    const fare = calculateFare({
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier: surge,
      childMode: trip.childMode,
    });

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: {
          destLat: destination.lat,
          destLon: destination.lon,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          routePolyline: route.polyline || null,
          fareCents: fare.cents,
        },
      });
      await this.recordEvent(tx, id, 'trip.destination_changed', {
        destination,
        previousFareCents: trip.fareCents,
        fareCents: fare.cents,
      });
      return next;
    });
    return toTripView(updated);
  }

  // ───────────────────────────── Derecho al olvido (Ley 29733) ─────────────────────────────

  /**
   * Anonimiza la PII de localización de TODOS los viajes de un pasajero tras el borrado efectivo
   * de su cuenta (BR-S06 derecho al olvido, evento `user.deleted`).
   *
   * Conserva la FILA del viaje (integridad financiera/auditoría: tarifa, comisión, estados,
   * `passengerId` como referencia huérfana ya tombstoneada en identity) pero ELIMINA las
   * coordenadas precisas de origen/destino, las paradas intermedias y la geometría de ruta:
   * el "dónde vive / a dónde va" de la persona. El log append-only `trip_events` no contiene
   * coordenadas (solo tarifa/distancia/categoría), por lo que no requiere scrubbing.
   *
   * Idempotente: es una sobre-escritura determinista (coords → 0, waypoints/polyline → null).
   * Reprocesar el mismo `user.deleted` deja la fila idéntica; `count` indica filas tocadas.
   *
   * Dominó de borrado (cascada): el VIDEO DE CABINA lo custodia media-service indexado por `tripId`,
   * que NO puede resolver el mapa usuario→viajes sin un join cross-servicio (prohibido). Por eso, en
   * la MISMA transacción que anonimiza, emitimos UN `trip.pii_erased` por cada viaje afectado para que
   * media-service purgue su grabación. Pre-leemos los ids ANTES de anonimizar (el updateMany no los
   * devuelve) para garantizar una señal por viaje. Idempotente: reprocesar reemite las mismas señales
   * sobre filas ya anonimizadas y media-service deduplica/no-op el borrado.
   */
  async anonymizePassenger(passengerId: string): Promise<{ anonymized: number }> {
    // Ids afectados ANTES de anonimizar: updateMany no devuelve filas, y los necesitamos para emitir
    // una señal de purga de video por viaje (el video se indexa por tripId en media-service).
    const affected = await this.prisma.read.trip.findMany({
      where: { passengerId },
      select: { id: true },
    });

    const erasedAt = new Date().toISOString();
    const count = await this.prisma.write.$transaction(async (tx) => {
      const result = await tx.trip.updateMany({
        where: { passengerId },
        data: {
          originLat: 0,
          originLon: 0,
          destLat: 0,
          destLon: 0,
          waypoints: Prisma.DbNull,
          routePolyline: null,
        },
      });
      // Una señal de purga de video por viaje afectado, en la misma transacción (outbox pattern).
      for (const { id } of affected) {
        await enqueueOutbox(
          tx,
          createEnvelope({
            eventType: 'trip.pii_erased',
            producer: PRODUCER,
            payload: { tripId: id, passengerId, at: erasedAt },
          }),
          id,
        );
      }
      return result.count;
    });

    this.logger.log(
      `Derecho al olvido: anonimizados ${count} viaje(s) del pasajero ${passengerId}; ` +
        `${affected.length} señal(es) trip.pii_erased emitida(s) (purga de video en media-service)`,
    );
    return { anonymized: count };
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  private async mustFind(id: string): Promise<Trip> {
    const trip = await this.prisma.write.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return trip;
  }

  private requireDriver(trip: Trip): string {
    if (!trip.driverId) {
      throw new ConflictError('El viaje no tiene conductor asignado', { tripId: trip.id });
    }
    return trip.driverId;
  }

  /** ETA estimada de llegada del conductor (assignedAt + duración de ruta), para BR-T03. */
  private estimateDriverEta(trip: Trip): Date | null {
    if (!trip.assignedAt) return null;
    return new Date(trip.assignedAt.getTime() + trip.durationSeconds * 1000);
  }

  private async recordEvent(
    tx: TxClient,
    tripId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.tripEvent.create({
      data: { tripId, eventType, payload: payload as Prisma.InputJsonValue },
    });
  }

}
