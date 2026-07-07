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
import type { AuthenticatedUser } from '@veo/auth';
import {
  PricingMode,
  TripStatus,
  PaymentMethod,
  ActorType,
  findOffering,
  OfferingId,
  GLOBAL_ZONE,
  type OfferingSpec,
  type OfferingPricingPolicy,
} from '@veo/shared-types';
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
import {
  assertTransition,
  InvalidTripTransition,
  LIVE_STATES,
  transitionSources,
} from './domain/trip-state-machine';
import { ActiveTripExistsError, OfferingUnavailableError } from './trips.errors';
import { CatalogService } from '../catalog/catalog.service';
import { calculateFirmFare } from './domain/fare';
import { calculateCancellationPenalty } from './domain/cancellation';
import { assertScheduleWindow } from './domain/scheduling';
import { resolveTripOffering, type TripOfferingResolution } from './domain/offering';
import { bumpCatalogDegraded } from './trip-metrics';
import { toTripView, readWaypoints } from './trip-view.mapper';
import { PRODUCER, recordTripEvent, emitBidPosted } from './trip-events';
import { DispatchModeRegistry } from './dispatch-mode/dispatch-mode.registry';
import { BaseFareService } from '../pricing/base-fare.service';
import { BidFloorService } from '../pricing/bid-floor.service';
import type { Env } from '../config/env.schema';
import type {
  AcceptTripDto,
  ArrivedTripDto,
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
   * Cliente Redis para el lockout anti-brute-force del código de modo niño (B). `@Optional()` para no
   * romper los tests legacy que construyen el servicio sin Redis (childMode sin lockout): si no se
   * inyecta, el gate de modo niño cae al comportamiento previo (validación de código sin contador).
   * En producción CoreModule lo provee (REDIS, global).
   */
  private readonly redis: Pick<Redis, 'get' | 'incr' | 'expire' | 'del' | 'set'> | null;

  /** Registry de estrategias por modo de despacho (open/closed). Self-default sin DI para tests legacy. */
  private readonly dispatchModes: DispatchModeRegistry;

  /**
   * Catálogo de ofertas (ADR 013 · Fase B). `@Optional()`: si no se inyecta (tests legacy que construyen
   * el servicio sin él), `null` ⇒ createTrip NO valida el `enabled` (permite, comportamiento previo). En
   * producción CatalogModule lo provee (importado en TripsModule). Degradación honesta: ante un error del
   * catálogo, createTrip PERMITE el viaje (no se bloquea un pedido por una lectura de config caída — mismo
   * criterio que el quote, que degrada a "todas las ofertas").
   */
  private readonly catalog: CatalogService | null;
  /**
   * Piso de la PUJA per-(zona, oferta) (ADR 010 §9.3). `@Optional()`: si no se inyecta (tests legacy que
   * construyen el servicio sin él), `null` ⇒ resolveBidFloorCents degrada al piso global de env
   * (`this.bidFloorCents`) — comportamiento previo. En producción PricingModule lo provee.
   */
  private readonly bidFloor: BidFloorService | null;
  /** F2.4 · tarifa base configurable (banderazo/km/min). `@Optional()`: sin él → constantes de código. */
  private readonly baseFare: BaseFareService | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Optional() config?: ConfigService<Env, true>,
    @Optional() @Inject(REDIS) redis?: Pick<Redis, 'get' | 'incr' | 'expire' | 'del' | 'set'>,
    @Optional() dispatchModes?: DispatchModeRegistry,
    @Optional() catalog?: CatalogService,
    @Optional() bidFloor?: BidFloorService,
    @Optional() baseFare?: BaseFareService,
  ) {
    this.bidFloorCents = config?.get('BID_FLOOR_CENTS') ?? DEFAULT_BID_FLOOR_CENTS;
    this.bidMaxCents = config?.get('BID_MAX_CENTS') ?? DEFAULT_BID_MAX_CENTS;
    this.bidWindowSec = config?.get('BID_WINDOW_SEC') ?? DEFAULT_BID_WINDOW_SEC;
    this.maxReassign = config?.get('TRIP_MAX_REASSIGN') ?? DEFAULT_MAX_REASSIGN;
    this.redis = redis ?? null;
    this.dispatchModes = dispatchModes ?? new DispatchModeRegistry(config);
    this.catalog = catalog ?? null;
    this.bidFloor = bidFloor ?? null;
    this.baseFare = baseFare ?? null;
  }

  /**
   * ADR 013 · Fase B / ADR 023 — resuelve la oferta EFECTIVA para CREAR en UNA lectura del catálogo: valida
   * que esté HABILITADA (defensa en profundidad de la carrera "el admin la apagó entre el quote y el create";
   * el gate primario es que el quote ya no la cotiza) y devuelve el pricing + el MODO EFECTIVOS (base ⟕
   * overlay del admin: `resolveCatalog` ya aplicó `effectiveOfferingMode` — la palanca manual del admin sobre
   * el default de código, respetando `modeLocked`). DEGRADACIÓN HONESTA: sin catálogo inyectado (tests legacy)
   * o si la lectura FALLA, usa el pricing + modo de CÓDIGO y PERMITE el viaje — no se bloquea un pedido por una
   * lectura de config caída (mismo criterio que el quote degradando a todas). Oferta deshabilitada →
   * OfferingUnavailableError (409).
   */
  private async resolveEffectiveOffering(
    base: OfferingSpec,
  ): Promise<{ pricing: OfferingPricingPolicy; mode: PricingMode }> {
    if (!this.catalog) return { pricing: base.pricing, mode: base.mode };
    let resolved;
    try {
      resolved = await this.catalog.resolveOffering(base.id);
    } catch (err) {
      // B5-4: las verticales ocultas (defaultEnabled:false) NUNCA se crean, ni en degradación — sin
      // confirmar que el admin las habilitó, permitir una ambulancia/grúa por catálogo caído sería el
      // leak inverso al de la UI. Las visibles por default SÍ se permiten (degradación honesta previa).
      if (!base.defaultEnabled) throw new OfferingUnavailableError(base.id);
      this.logger.warn(
        `catálogo no disponible al resolver '${base.id}' (${(err as Error).message}); ` +
          `uso el pricing y modo de código y permito el viaje (degradación honesta · ADR 013)`,
      );
      bumpCatalogDegraded('create');
      return { pricing: base.pricing, mode: base.mode };
    }
    if (resolved && !resolved.enabled) throw new OfferingUnavailableError(base.id);
    // Sin entrada en el overlay (no debería pasar: el id sale del catálogo de código) → pricing/modo de código.
    if (!resolved) return { pricing: base.pricing, mode: base.mode };
    return { pricing: resolved.pricing, mode: resolved.mode };
  }

  /**
   * F2.4 · banderazo/km/min vigentes (config del admin, `BaseFareConfig`). Devuelve el triple o `{}` si el
   * servicio no está (tests) o la lectura cae → la fórmula usa las constantes de código (degradación honesta;
   * el seed sembró los valores actuales, así que en prod la fila existe y NO hay cambio de precio).
   */
  private async resolveBaseFare(): Promise<{
    baseFareCents?: number;
    perKmCents?: number;
    perMinCents?: number;
  }> {
    if (!this.baseFare) return {};
    try {
      const c = await this.baseFare.getConfig();
      return {
        baseFareCents: c.baseFareCents,
        perKmCents: c.perKmCents,
        perMinCents: c.perMinCents,
      };
    } catch (err) {
      this.logger.warn(
        `tarifa base no disponible (${(err as Error).message}); uso las constantes de código (F2.4)`,
      );
      return {};
    }
  }

  /**
   * ADR 013 §2 · seam de resolución de la oferta del create. Delegación PURA en el resolver de dominio
   * (domain/offering.ts). `protected` a propósito: los specs subclasean el servicio para inyectar una
   * oferta a medida (p.ej. una vertical solo-FIXED) sin inventar una entrada fantasma en producción.
   */
  protected resolveOffering(dto: CreateTripDto): TripOfferingResolution {
    return resolveTripOffering(dto.category, dto.vehicleType);
  }

  /**
   * Piso del bid para (zona, oferta) (ADR 010 §9.3). Resuelto por BidFloorService: config versionada que el
   * admin maneja en caliente (default + overrides por oferta), vía el resolver PURO `resolveBidFloorCents`
   * (@veo/shared-types) — el MISMO que el public-bff usa para el display del quote (consistencia por
   * construcción). Per-oferta hoy; per-zona no-breaking (la firma ya transporta la zona vía `GLOBAL_ZONE`).
   * DEGRADACIÓN: sin el servicio inyectado (tests legacy) cae al piso global de env (`this.bidFloorCents`).
   */
  private async resolveBidFloorCents(offeringId: OfferingId | null): Promise<number> {
    if (this.bidFloor) {
      // Sin oferta conocida (viaje legacy con `category` null) → la oferta fue la ancla económico (el default
      // de `resolveOffering`); resolvemos su piso (si no tiene override, cae al default igual). MVP Tier 1:
      // zona SIEMPRE GLOBAL (per-zona es no-breaking cuando exista).
      return this.bidFloor.resolve(GLOBAL_ZONE, offeringId ?? OfferingId.VEO_ECONOMICO);
    }
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

    // ADR 013 §2 · resuelve la OFERTA del catálogo (fuente única de pool + pricing + modo) con la
    // precedencia EXACTA: category > vehicleType > default económico. Categoría desconocida → 400
    // UNKNOWN_OFFERING (jamás default silencioso a económico). El seam protected permite a los specs
    // inyectar una oferta a medida (p.ej. una vertical PUJA/FIXED) sin tocar el catálogo de producción.
    const { offering, mismatch } = this.resolveOffering(dto);
    if (mismatch) {
      // category y vehicleType inconsistentes (bug de UI de una app vieja): GANA la oferta —
      // offering.vehicleClass es la fuente del pool de matching. No 400: no rompemos apps en la calle.
      this.logger.warn(
        `createTrip: category '${offering.id}' y vehicleType '${dto.vehicleType}' inconsistentes; ` +
          `gana la oferta (pool ${offering.vehicleClass}) (ADR 013 §2)`,
      );
    }
    // ADR 013 · Fase B / ADR 023 — resuelve la oferta EFECTIVA (base ⟕ overlay del admin) en UNA lectura:
    // valida que esté HABILITADA (defensa en profundidad: el quote ya no cotiza las apagadas; cubre la
    // carrera admin-apaga-entre-quote-y-create) y trae el pricing + el MODO efectivos. Degrada honesto.
    const { pricing: effectivePricing, mode } = await this.resolveEffectiveOffering(offering);
    // ADR 013 · Trip.vehicleType DERIVA de la oferta (no del dto suelto): dispatch filtra por el pool
    // certificable de la oferta elegida.
    const vehicleType: PrismaVehicleType = offering.vehicleClass;

    // Ruta multi-punto (origen → paradas → destino): distancia/duración incluyen las paradas. La
    // ruta sigue alimentando distancia/duración/polyline aunque el precio venga del bid (la puja no
    // cambia la geometría; la distancia es necesaria para la penalización BR-T03 y las pantallas).
    const route = await this.maps.route(origin, destination, waypoints);
    const surge = dto.surgeMultiplier ?? 1.0;

    // ADR 023 · resolve-once-persist-forever: el modo de despacho del viaje es el MODO EFECTIVO de la
    // OFERTA (default de código ⟕ palanca manual del admin; una vertical `modeLocked` lo fija). YA NO hay
    // schedule/franjas (ADR 011 superseded) ni derivación por `dto.bidCents` del cliente: la oferta manda.
    // `mode` ya viene resuelto de `resolveEffectiveOffering` y se CONGELA en Trip.dispatchMode — la
    // reasignación / activación de programados lo leen de la fila, NUNCA re-resuelven de la config actual.
    //
    // El modo fija la tarifa + el seq de negociación vía Strategy (open/closed):
    //  - PUJA (ADR 010 §2): valida el bid (piso ≤ bid ≤ techo) y el bid ES el fareCents; seq=1. Falta el
    //    bid → 400 "falta tu oferta". El surge solo SUGIERE (decisión #5), no se aplica al bid.
    //  - FIXED (BR-T05 + ADR 013 §1.7): IGNORA el bid, calcula la tarifa firme por ruta y le aplica la
    //    política de la oferta — max(round(calculateFare × multiplier), minFareCents); seq=0.
    // Un modo sin strategy falla FUERTE (forMode lanza), no cae silenciosamente en PUJA.
    // Las 2 lecturas de config de pricing son INDEPENDIENTES entre sí → en paralelo (no encadenar awaits en
    // el hot-path del create). Notas por insumo:
    //  - bid-floor: piso AUTORITATIVO de la puja per-(zona, oferta) (ADR 010 §9.3).
    //  - base: banderazo/km/min GLOBALES vigentes (admin, F2.4); solo FIXED; degrada a las constantes de código.
    const [bidFloorCents, baseFare] = await Promise.all([
      this.resolveBidFloorCents(offering.id),
      this.resolveBaseFare(),
    ]);
    // ADR 023 §3 · los params POR-SERVICIO de la oferta (banderazo/km/min) PISAN el default global; si la
    // oferta no los define (`undefined`) → el global (BaseFareService); si el global tampoco → las constantes
    // de código (en `calculateFare`). Así el Mecánico (call-out plano, perKm/perMin 0) y la Grúa (sin per-min)
    // cobran su fórmula propia sin tocar el resto del catálogo. Para los rides (params `undefined`) el número
    // NO cambia: cae al global exactamente como antes.
    const { fareCents, negotiationSeq } = this.dispatchModes.forMode(mode).resolveCreation({
      bidCents: dto.bidCents,
      floorCents: bidFloorCents,
      route: { distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds },
      surge,
      childMode: dto.childMode ?? false,
      baseFareCents: effectivePricing.baseFareCents ?? baseFare.baseFareCents,
      perKmCents: effectivePricing.perKmCents ?? baseFare.perKmCents,
      perMinCents: effectivePricing.perMinCents ?? baseFare.perMinCents,
      pricing: effectivePricing,
    });
    const currency = 'PEN';

    // El modo RESUELTO se CONGELA en la fila del viaje (ADR 023 · resolve-once-persist-forever).
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
          waypoints:
            waypoints.length > 0 ? (waypoints as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          scheduledFor,
          vehicleType,
          // ADR 023: modo de despacho congelado del viaje = el modo EFECTIVO de la oferta (FIXED/PUJA).
          dispatchMode,
          fareCents,
          currency,
          surgeMultiplier: new Prisma.Decimal(surge),
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          paymentMethod: dto.paymentMethod,
          status: initialStatus,
          routePolyline: route.polyline || null,
          // Categoría elegida en la cotización: se PERSISTE tal cual la mandó el cliente
          // (quoteOption.id, validada contra el catálogo arriba; null = cliente viejo sin el campo —
          // su oferta default ya alimentó pricing/pool igual). ADR 013 §1.7: la tarifa firme YA aplica
          // la política de la oferta (multiplier + minFare) vía el Strategy — deuda saldada.
          category: dto.category ?? null,
          childMode: dto.childMode ?? false,
          childCodeHash,
          promoCode: dto.promoCode ?? null,
          // BE-2 · solicitudes especiales (mascota/equipaje/silla). El conductor las ve antes de aceptar.
          specialRequests: dto.specialRequests ?? [],
          idempotencyKey: idempotencyKey ?? null,
          // H13 — la puja abre el PRIMER ciclo de negociación (seq=1, lo fija el Strategy); FIXED queda en 0
          // (nunca emite offer_accepted → applyAgreedFare no aplica). El seq es monotónico: rebid y la
          // reasignación lo INCREMENTAN (nunca resetean, a diferencia de reassignCount).
          negotiationSeq,
        },
      });

      if (scheduledFor) {
        // Programado: no entra a dispatch todavía. Solo registramos la reserva (el scheduler activa).
        // Nota: la activación programada usa el camino legacy trip.requested (la puja diferida es un
        // follow-up — ver REPORT). El precio ya quedó fijado (bid o tarifa por ruta) al crear.
        await recordTripEvent(tx, created.id, 'trip.scheduled', {
          scheduledFor: scheduledFor.toISOString(),
          fareCents,
          vehicleType,
          waypoints: waypoints.length,
        });
      } else {
        // Apertura del despacho según el modo CONGELADO (Strategy, open/closed): PUJA → trip.bid_posted
        // (abre el OfferBoard); FIXED → trip.requested (matching secuencial). Un modo sin strategy falla
        // FUERTE (forMode lanza), no cae silenciosamente en la rama PUJA.
        await this.dispatchModes.forMode(mode).openDispatch(tx, created, origin, destination, {
          scheduled: false,
        });
      }
      return created;
    });

    return toTripView(trip);
  }

  // ───────────────────────────── Cierre post-viaje (re-entrada) ─────────────────────────────

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

  // ───────────────────────────── Transiciones ─────────────────────────────

  /** POST /trips/:id/assign — asigna conductor/vehículo. Emite trip.assigned. */
  async assignDriver(id: string, dto: AssignTripDto): Promise<TripView> {
    return this.assign(id, dto.driverId, dto.vehicleId);
  }

  /**
   * Asignación disparada por dispatch.match_found (consumidor Kafka). dispatch resuelve el vehículo
   * ACTIVO del conductor al aceptar y lo adjunta en el evento (`vehicleId` opcional, best-effort): si
   * viene, se persiste en el viaje (trazabilidad viaje→vehículo); si no (fleet no respondió), se asigna
   * solo el conductor. Idempotente: si el viaje ya está ASSIGNED con ese conductor, no hace nada.
   */
  async assignFromDispatch(id: string, driverId: string, vehicleId?: string): Promise<void> {
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
      await this.assign(id, driverId, vehicleId ?? null);
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

  /**
   * GUARD CAS ATÓMICO genérico para las transiciones de viaje OPERADAS POR EL USUARIO (accept/arriving/
   * arrived/start/complete/cancel/fail). Mueve el viaje a `to` en el MISMO statement que valida que era
   * una transición legal — `status` viaja en el WHERE del updateMany (`status: { in: transitionSources(to) }`),
   * NO se hace check-then-act. Cierra la carrera en que dos taps concurrentes pisan un terminal (ej. accept
   * pisando CANCELLED_BY_PASSENGER → viaje zombie; complete cobrando un viaje ya cancelado).
   *
   * Si el claim NO movió fila (count === 0) el viaje no existe o ya NO estaba en un estado fuente: releemos
   * para dar un error HONESTO con el `from` real → !current ⇒ NotFoundError; current ⇒ InvalidTripTransition
   * (409). A diferencia de los handlers de consumidores Kafka (assign/cancelFromBid/expireFromNoOffers/
   * watchdog) que tratan count===0 como no-op idempotente, estas 7 son acciones de usuario y DEBEN fallar 409.
   *
   * NO emite eventos: `recordTripEvent`/`enqueueOutbox` varían por método y van AGUAS ABAJO del claim, en la
   * misma tx, para que un CAS perdido NO emita el evento. `data` lleva los campos sin `status` (lo setea el
   * helper). Devuelve void: el caller relee con `findUniqueOrThrow` la fila ya escrita.
   */
  private async casTransition(
    tx: Prisma.TransactionClient,
    id: string,
    to: TripStatus,
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<void> {
    const claim = await tx.trip.updateMany({
      where: { id, status: { in: transitionSources(to) } },
      data: { status: to, ...data },
    });
    if (claim.count === 0) {
      const current = await tx.trip.findUnique({ where: { id } });
      if (!current) throw new NotFoundError('Viaje no encontrado', { id });
      throw new InvalidTripTransition(current.status, to);
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
      await recordTripEvent(tx, id, 'trip.assigned', { driverId, vehicleId });
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
    // A1 · ownership server-side (anti-IDOR, defensa en profundidad junto al gate del driver-bff): solo el
    // conductor ASIGNADO avanza SU viaje. El driver-bff DERIVA el driverId del perfil y lo manda; lo
    // verificamos acá. 404 (no 403) para no filtrar la existencia de un viaje ajeno. Condicional: callers
    // legacy sin driverId siguen andando (mismo criterio que start/complete).
    if (dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }
    assertTransition(trip.status, TripStatus.ACCEPTED);
    const etaSeconds = dto.etaSeconds ?? 300;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico: el assertTransition de arriba es solo pre-check fail-fast (UX antes de abrir tx); el
      // guard REAL contra la carrera va acá (status en el WHERE). Si el viaje cayó a un terminal entre el
      // mustFind y este claim, casTransition lanza InvalidTripTransition y el evento NO se emite.
      await this.casTransition(tx, id, TripStatus.ACCEPTED, { acceptedAt: new Date() });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.accepted', { driverId: trip.driverId, etaSeconds });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.accepted',
          producer: PRODUCER,
          // passengerId ENRIQUECIDO: notification-service resuelve el token del pasajero (push "tu
          // conductor confirmó") sin un join cross-servicio.
          payload: {
            tripId: id,
            driverId: this.requireDriver(trip),
            etaSeconds,
            passengerId: trip.passengerId,
          },
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
    // A1 · ownership server-side (anti-IDOR): solo el conductor asignado avanza SU viaje (404 si no calza).
    if (dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }
    assertTransition(trip.status, TripStatus.ARRIVING);
    const etaSeconds = dto.etaSeconds ?? 120;
    const at = new Date();

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico (ver acceptTrip): assertTransition es pre-check; el guard de carrera va en el WHERE.
      await this.casTransition(tx, id, TripStatus.ARRIVING, { arrivingAt: at });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.arriving', { etaSeconds });
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
  async arrived(id: string, dto: ArrivedTripDto = {}): Promise<TripView> {
    const trip = await this.mustFind(id);
    // A1 · ownership server-side (anti-IDOR): solo el conductor asignado avanza SU viaje (404 si no calza).
    if (dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }
    assertTransition(trip.status, TripStatus.ARRIVED);
    const at = new Date();

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico (ver acceptTrip): assertTransition es pre-check; el guard de carrera va en el WHERE.
      await this.casTransition(tx, id, TripStatus.ARRIVED, { arrivedAt: at });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.arrived', {});
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.arrived',
          producer: PRODUCER,
          // passengerId ENRIQUECIDO: push "tu conductor llegó". waitWindowSeconds NO se emite: el
          // dominio aún no modela una ventana de espera del conductor (gap honesto; el schema la soporta
          // como opcional para cuando exista, y el consumidor la incluye en el push solo si viaja).
          payload: {
            tripId: id,
            driverId: this.requireDriver(trip),
            at: at.toISOString(),
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
        throw new ValidationError(
          'Este viaje requiere el código de modo niño para iniciar (BR-T07)',
        );
      }
      const ok = trip.childCodeHash ? bcrypt.compareSync(dto.childCode, trip.childCodeHash) : false;
      if (!ok) {
        // B · registra el intento fallido (atómico) y, si alcanza el tope, echa el candado de 15 min.
        // El nº de intento VIAJA en el evento (contrato del registro central): para la alerta al
        // padre/madre el 3er intento no es lo mismo que el 1ro.
        const attempt = await this.registerChildCodeFailure(id);
        const at = new Date().toISOString();
        await this.prisma.write.$transaction(async (tx) => {
          await recordTripEvent(tx, id, 'trip.child_code_failed', { attempt, at });
          await enqueueOutbox(
            tx,
            createEnvelope({
              eventType: 'trip.child_code_failed',
              producer: PRODUCER,
              payload: {
                tripId: id,
                passengerId: trip.passengerId,
                // El schema central modela driverId como string opcional (nunca null): un null
                // serializado al outbox haría fallar el parse del relay al publicar.
                driverId: trip.driverId ?? undefined,
                attempt,
                at,
              },
            }),
            id,
          );
        });
        throw new ValidationError(
          'Código de modo niño incorrecto; el viaje no puede iniciar (BR-T07)',
        );
      }
      // B · código correcto → resetea contador y candado (Redis): el viaje pudo iniciar limpio.
      await this.resetChildCodeAttempts(id);
    }

    const startedAt = new Date();
    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico (ver acceptTrip): assertTransition es pre-check; el guard de carrera va en el WHERE.
      await this.casTransition(tx, id, TripStatus.IN_PROGRESS, { startedAt });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.started', { startedAt: startedAt.toISOString() });
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
   * B · registra UN intento fallido del código de modo niño (atómico vía INCR) y devuelve el Nº DE
   * INTENTO dentro de la ventana (1..tope): viaja en `trip.child_code_failed` para que la alerta al
   * padre/madre distinga el 3er intento del 1ro. En el PRIMER intento arma la ventana de 15 min
   * (EXPIRE) para que el contador se auto-limpie. Al alcanzar el tope (5) echa el candado de 15 min
   * (EX 900). INCR es atómico ⇒ robusto a reintentos concurrentes; el último que cruza el umbral setea
   * el lock (idempotente: re-setearlo solo refresca el mismo TTL). Sin Redis (tests legacy) degrada
   * honesto a 1: no hay contador, pero "hubo al menos este intento" y el evento no viaja sin el dato.
   */
  private async registerChildCodeFailure(tripId: string): Promise<number> {
    if (!this.redis) return 1;
    const attempts = await this.redis.incr(childCodeAttemptsKey(tripId));
    if (attempts === 1) {
      // primer fallo de la ventana → arma el TTL del contador (se auto-resetea si no se llega al tope).
      await this.redis.expire(childCodeAttemptsKey(tripId), CHILD_CODE_LOCK_SECONDS);
    }
    if (attempts >= CHILD_CODE_MAX_ATTEMPTS) {
      await this.redis.set(childCodeLockKey(tripId), '1', 'EX', CHILD_CODE_LOCK_SECONDS);
    }
    return attempts;
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
      trip.paymentMethod === PaymentMethod.CASH ? (dto.cashCollected ?? undefined) : undefined;

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico CRÍTICO (cobro): si una carrera ya canceló el viaje (CANCELLED_BY_*), el claim falla y
      // NO se emite trip.completed → payment-service NO cobra un viaje muerto. assertTransition arriba es
      // solo pre-check fail-fast; el guard autoritativo va en el WHERE del updateMany.
      await this.casTransition(tx, id, TripStatus.COMPLETED, { completedAt });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.completed', { fareCents: trip.fareCents });
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
  async cancel(id: string, dto: CancelTripDto, user: AuthenticatedUser): Promise<TripView> {
    const trip = await this.mustFind(id);

    // A1 · ownership server-side (anti-IDOR, defensa en profundidad junto al gate del BFF): un pasajero
    // solo cancela SU viaje. 404 (no 403) para no filtrar la existencia de un viaje ajeno. Se usa el
    // `user.userId` de la identidad FIRMADA (siempre presente vía InternalIdentityGuard), NO un id del body
    // — sin skip condicional: un payload sin/forjado passengerId ya no saltea el check. La cancelación por
    // CONDUCTOR usa driverId (su BFF lo deriva; el firmado aún no lo trae fiable) — se re-chequea abajo.
    if (dto.by === ActorType.PASSENGER && trip.passengerId !== user.userId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }

    // A1 · ownership del CONDUCTOR (simétrico al del pasajero). Va ANTES de la rama de reasignación
    // POST-accept para que un tripId ajeno no dispare un reassign del viaje de otro. Permisivo con
    // callers sin driverId (compat), como start/complete; el gate fuerte está en el BFF que lo deriva.
    if (dto.by === ActorType.DRIVER && dto.driverId && trip.driverId !== dto.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id });
    }

    if (dto.by === ActorType.DRIVER && POST_ACCEPT_STATES.has(trip.status)) {
      return this.reassignAfterDriverCancel(trip, dto.reason);
    }

    const target =
      dto.by === ActorType.PASSENGER
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
      // CAS atómico CRÍTICO (split de penalidad): el `target` ya está resuelto (passenger vs driver) ANTES
      // de abrir la tx; el claim valida que el viaje SIGUE en un estado cancelable. Si una carrera ya lo
      // movió a un terminal, el claim falla y NO se emite trip.cancelled → payment-service NO procesa un
      // split sobre un viaje muerto. El cálculo de penaltyCents es puro (pre-tx) y se descarta solo si el
      // CAS pierde. assertTransition(target) arriba es solo pre-check fail-fast.
      await this.casTransition(tx, id, target, {
        cancelledAt: now,
        cancelledBy: dto.by,
        cancellationReason: dto.reason ?? null,
        penaltyCents,
      });
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.cancelled', {
        by: dto.by,
        penaltyCents,
        reason: dto.reason,
      });
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

    // ADR 011 §1.2/§4 · resolve-once: la reasignación respeta el modo CONGELADO del viaje (NO re-resuelve de
    // la config admin). El DELTA por modo vive en el Strategy (open/closed): PUJA re-abre el OfferBoard
    // (REASSIGNING + reset H12 agreedFareCents + bump H13 negotiationSeq + trip.reassigning enriquecido);
    // FIXED re-emite trip.requested (sin tocar seq/agreedFare). assertTransition(REASSIGNING) y el guard de
    // tope→FAILED son TRANSVERSALES (no por-modo) → quedan acá. forMode lanza si el modo no tiene strategy.
    assertTransition(trip.status, TripStatus.REASSIGNING);
    const updated = await this.prisma.write.$transaction((tx) =>
      this.dispatchModes.forMode(trip.dispatchMode).reassign(tx, trip, nextReassignCount, reason),
    );
    this.logger.log(
      `Viaje ${trip.id} ${trip.status} → REASSIGNING (modo ${trip.dispatchMode}; reasignación ` +
        `${nextReassignCount}/${this.maxReassign})`,
    );
    return toTripView(updated);
  }

  /**
   * Fase B (ADR-021 · finding B1 · B-react) — el conductor pasó a OFFLINE (`driver.went_offline`: fin de
   * turno o caída de socket sin reconexión). Si tenía un viaje PRE-RECOJO ya ACEPTADO (ACCEPTED/ARRIVING/
   * ARRIVED) lo REASIGNAMOS: el pasajero consigue otro conductor en vez de esperar los ~15min del watchdog
   * pre-recojo (que solo EXPIRA, sin re-match). REUSAMOS la máquina existente `reassignAfterDriverCancel`
   * (la MISMA del cancel EXPLÍCITO del conductor): respeta el modo CONGELADO del viaje + el tope de
   * re-asignaciones + emite `trip.reassigning` (dispatch re-abre el board y libera al conductor). NO se
   * duplica lógica de reasignación: solo se enruta el viaje del conductor offline hacia ella.
   *
   * ALCANCE (in-scope de Fase B): SOLO POST_ACCEPT_STATES. Un viaje en ASSIGNED (el pasajero eligió pero el
   * conductor aún no tocó "aceptar") NO se reasigna por esta vía — ASSIGNED→REASSIGNING NO es transición
   * legal de la máquina (igual que el cancel desde ASSIGNED, terminal); abrir ese camino es Fase G.
   *
   * IDEMPOTENTE: sin viaje pre-recojo del conductor (ya reasignado/terminado, o nunca aceptó) es no-op. Los
   * eventos de UN conductor caen en la MISMA partición del topic 'driver' → se procesan SERIAL, así una
   * segunda entrega ve el viaje ya en REASSIGNING (fuera de POST_ACCEPT) → no re-reasigna.
   */
  async reassignForDriverOffline(driverId: string): Promise<void> {
    const trip = await this.prisma.read.trip.findFirst({
      where: { driverId, status: { in: [...POST_ACCEPT_STATES] } },
      orderBy: { assignedAt: 'desc' },
    });
    if (!trip) return;
    this.logger.log(
      `Conductor ${driverId} offline con viaje ${trip.id} (${trip.status}) pre-recojo → reasignando`,
    );
    await this.reassignAfterDriverCancel(trip, 'driver_offline');
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
      // CAS atómico (ver acceptTrip): assertTransition(FAILED) arriba es pre-check; el guard de carrera va
      // en el WHERE. Si el viaje ya cayó a otro terminal entre el read y este claim, lanza y no emite.
      await this.casTransition(tx, trip.id, TripStatus.FAILED, {
        driverId: null,
        reassignCount,
        cancelledAt: at,
        cancellationReason: 'max_reassign_exceeded',
      });
      const next = await tx.trip.findUniqueOrThrow({ where: { id: trip.id } });
      const payload = {
        tripId: trip.id,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: cancelledDriverId ?? undefined,
        staleMinutes: 0,
        at: at.toISOString(),
      };
      await recordTripEvent(tx, trip.id, 'trip.failed', {
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
      await recordTripEvent(tx, tripId, 'trip.fare_agreed', {
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
    this.logger.log(
      `PUJA: viaje ${tripId} fareCents ${trip.fareCents} → ${priceCents} (precio acordado)`,
    );
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
      await recordTripEvent(tx, tripId, 'trip.expired', { ...payload, reason });
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
      await recordTripEvent(tx, tripId, 'trip.cancelled', {
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
          payload: {
            tripId,
            by: 'PASSENGER',
            reason: 'bid_cancelled',
            penaltyCents: 0,
            passengerId: trip.passengerId,
          },
        }),
        tripId,
      );
    });
    this.logger.log(
      `PUJA: viaje ${tripId} ${trip.status} → CANCELLED_BY_PASSENGER (bid_cancelled)`,
    );
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
      throw new ConflictError(
        'El viaje no admite re-puja en el estado actual (solo REASSIGNING/EXPIRED)',
        {
          status: trip.status,
        },
      );
    }

    // Gate AUTORITATIVO de la puja (espeja createTrip): piso (zona, oferta) ≤ bid ≤ techo (anti-overflow int4).
    // El piso es el de la oferta del viaje (`trip.category`); legacy sin categoría → ancla económico.
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const offeringId = findOffering(trip.category ?? '')?.id ?? null;
    const floor = await this.resolveBidFloorCents(offeringId);
    if (bidCents < floor) {
      throw new ValidationError(
        `El bid (${bidCents}) es menor al piso de la oferta (${floor}) (ADR 010 §9.3)`,
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
          // ADR-019 Lote B: re-pujar ES una acción de PUJA por definición (el endpoint recibe `bidCents`:
          // el pasajero ofrece SU precio → subasta). Persistimos dispatchMode=PUJA para que el valor
          // CONGELADO deje de mentir: antes un viaje FIXED que expiraba, al re-pujar, abría un OfferBoard
          // (PUJA) pero conservaba dispatchMode=FIXED → un driver-cancel posterior tomaba el path FIXED
          // (secuencial 12s) mientras su re-bid fue subasta (60s), violando ADR-011 resolve-once-persist.
          // Ahora el modo persistido coincide con el mecanismo real (emitBidPosted abajo).
          dispatchMode: PrismaPricingMode.PUJA,
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
        // Espeja el flip persistido (ADR-019 Lote B): el modo del viaje reactivado ES PUJA.
        dispatchMode: PrismaPricingMode.PUJA,
        driverId: null,
        reassignCount: 0,
        // H13 — espeja el incremento del updateMany para que emitBidPosted estampe el seq del nuevo ciclo.
        negotiationSeq: trip.negotiationSeq + 1,
      };
      await recordTripEvent(tx, tripId, 'trip.rebid', {
        from: fromStatus,
        previousBidCents: trip.fareCents,
        bidCents,
      });
      // Reusa el camino canónico de la puja: trip.bid_posted → dispatch abre un OfferBoard FRESCO al nuevo bid.
      await emitBidPosted(tx, reactivated, origin, this.bidWindowSec);
      return reactivated;
    });

    if (updated === null) {
      // Doble-tap: releemos el viaje ya reactivado (idempotente, no re-emitimos eventos).
      this.logger.log(
        `PUJA: re-bid duplicado de viaje ${tripId} (ya reactivado); no-op idempotente`,
      );
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
    // Re-cotiza con la MISMA fórmula firme del create (`calculateFirmFare`: multiplier + mínima + fee de niño plano).
    // Sin esto, `calculateFare` base reseteaba la tarifa sin multiplier: un FIXED Premium/XL podía cambiar
    // de destino (aun al mismo punto) y cobrar de menos. En FIXED SIN piso contra `trip.fareCents` (un
    // destino MÁS CERCA debe abaratar); en PUJA SÍ hay piso al bid acordado (ver A3, más abajo). El piso de
    // la mínima de la oferta ya está dentro de la fórmula.
    const { offering } = resolveTripOffering(trip.category, trip.vehicleType);
    const fareInput = {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier: surge,
      childMode: trip.childMode,
      // F2.4 · banderazo/km/min configurables (degradan a las constantes de código).
      ...(await this.resolveBaseFare()),
    };
    const fare = calculateFirmFare(fareInput, offering.pricing);
    // ADR-022 P-A (A3) · en PUJA el `trip.fareCents` es un BID NEGOCIADO que el conductor ACEPTÓ. Cambiar el
    // destino NO puede cobrar por DEBAJO de lo acordado (regalarle plata al pasajero reseteando la
    // negociación hacia abajo) — espejo del piso de waypoint-proposal.service. En FIXED sí abarata (la tarifa
    // es fórmula de la ruta: un destino más cerca cuesta menos, sin negociación que respetar).
    const fareCents =
      trip.dispatchMode === PricingMode.FIXED ? fare.cents : Math.max(fare.cents, trip.fareCents);

    const updated = await this.prisma.write.$transaction(async (tx) => {
      // CAS: el gate de estado (DESTINATION_EDITABLE) se RE-VALIDA dentro de la tx (viaja en el WHERE). El
      // chequeo de arriba se hizo sobre una lectura previa al `maps.route` (cientos de ms); una carrera que
      // sacó el viaje de un estado editable (start/complete/cancel) en esa ventana → count 0 → ConflictError.
      // Sin esto, el update por-id pisaría destino+fareCents en un viaje ya no editable (mutación financiera
      // post-completion). Patrón espejo del CAS de accept()/waypoint.
      const claim = await tx.trip.updateMany({
        where: { id, status: { in: [...DESTINATION_EDITABLE] } },
        data: {
          destLat: destination.lat,
          destLon: destination.lon,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          routePolyline: route.polyline || null,
          fareCents,
        },
      });
      if (claim.count === 0) {
        throw new ConflictError('No se puede cambiar el destino en el estado actual', { id });
      }
      const next = await tx.trip.findUniqueOrThrow({ where: { id } });
      await recordTripEvent(tx, id, 'trip.destination_changed', {
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
}
