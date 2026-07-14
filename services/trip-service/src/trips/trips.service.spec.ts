import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from '@veo/utils';
import { EVENT_SCHEMAS } from '@veo/events';
import {
  TripStatus,
  PaymentMethod,
  PricingMode,
  OFFERINGS,
  OfferingId,
  VehicleClass,
} from '@veo/shared-types';
import type { AuthenticatedUser } from '@veo/auth';
import { TripsService } from './trips.service';
import { TripsRepository } from './trips.repository';
import { ActiveTripExistsError, OfferingUnavailableError } from './trips.errors';
import { emitTripRequested, emitBidPosted } from './trip-events';
import { catalogDegradedTotal } from './trip-metrics';
import { TripQueryService } from './trip-query.service';
import { TripQueryRepository } from './trip-query.repository';
import { ScheduledTripService } from './scheduled-trip.service';
import { ScheduledTripRepository } from './scheduled-trip.repository';
import { InvalidTripTransition } from './domain/trip-state-machine';
import { Prisma, type Trip } from '../generated/prisma';

/** Lee el total de veo_catalog_degraded_total para un `site` (suma de sus labels). #2 observabilidad. */
async function readCatalogDegraded(site: string): Promise<number> {
  const { values } = await catalogDegradedTotal.get();
  return values.filter((v) => v.labels.site === site).reduce((s, v) => s + v.value, 0);
}

/**
 * Doble de CatalogService.resolveOffering (ADR 013 · ADR 023): devuelve una oferta EFECTIVA a medida
 * (enabled + pricing efectivo + `mode` efectivo), o lanza para simular el catálogo caído. `mode` modela la
 * palanca manual del admin sobre el modo de la oferta (default = el de código). `as never` porque createTrip
 * solo usa resolveOffering del puerto.
 */
function fakeCatalog(opts: {
  enabled?: boolean;
  multiplier?: number;
  minFareCents?: number;
  mode?: PricingMode;
  throws?: boolean;
}) {
  return {
    resolveOffering: async (id: string) => {
      if (opts.throws) throw new Error('catálogo caído');
      const base = OFFERINGS[id as OfferingId] ?? OFFERINGS[OfferingId.VEO_ECONOMICO];
      return {
        ...base,
        enabled: opts.enabled ?? true,
        pricing: {
          multiplier: opts.multiplier ?? base.pricing.multiplier,
          minFareCents: opts.minFareCents ?? base.pricing.minFareCents,
        },
        mode: opts.mode ?? base.mode,
      };
    },
  } as never;
}

/** Identidad autenticada de prueba. cancel() usa user.userId como dueño (anti-IDOR), no el dto. */
function userOf(userId: string, type: 'passenger' | 'driver' = 'passenger'): AuthenticatedUser {
  return { userId, type, roles: [], sessionId: 's1' };
}
/** Para los cancels del CONDUCTOR: la rama de pasajero se saltea, así que el userId no importa. */
const DRIVER_USER = userOf('drv-user', 'driver');

// ── Dobles de prueba (sin Nest DI), al estilo de identity-service ──

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const now = new Date('2026-05-28T12:00:00.000Z');
  return {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: null,
    vehicleId: null,
    originLat: -12.0464,
    originLon: -77.0428,
    destLat: -12.1219,
    destLon: -77.0297,
    waypoints: null,
    scheduledFor: null,
    activatedAt: null,
    vehicleType: 'CAR',
    // ADR 011 — modo de despacho congelado. La base es un viaje puja (negotiationSeq 1); los tests
    // legacy/fixed lo sobreescriben con 'FIXED'.
    dispatchMode: 'PUJA',
    requestedAt: now,
    assignedAt: null,
    acceptedAt: null,
    arrivingAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    passengerClosedAt: null,
    fareCents: 1500,
    agreedFareCents: null,
    currency: 'PEN',
    surgeMultiplier: new Prisma.Decimal(1),
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'YAPE',
    status: TripStatus.REQUESTED,
    routePolyline: 'abc',
    category: null,
    childMode: false,
    childCodeHash: null,
    promoCode: null,
    specialRequests: [],
    cancelledBy: null,
    cancellationReason: null,
    penaltyCents: 0,
    reassignCount: 0,
    // H13 — por defecto el viaje arranca en el ciclo de negociación 1 (camino puja). Tests legacy que
    // necesiten otro ciclo lo sobreescriben (ej. cycle 2 tras reassign).
    negotiationSeq: 1,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface PublishedEvent {
  eventType: string;
  envelope: { eventType: string; payload: unknown };
}

/** Prisma falso con un único viaje en memoria. Captura los eventos encolados en el outbox. */
function makePrisma(
  initial: Trip | null,
  // Simula una carrera concurrente: en el PRÓXIMO updateMany del CAS de changeDestination (el que lleva
  // `fareCents` en el WHERE), muta el store con estos valores y devuelve count 0 — como si otro escritor
  // hubiese ganado entre el re-read in-tx y el write. Cubre la atribución de causa (status vs fare_changed).
  raceOnDestinationCas?: { status?: TripStatus; fareCents?: number },
  // RC23 · simula que, tras tomar el advisory lock in-tx, el re-check `tx.trip.findFirst` encuentra un viaje
  // vivo (otra tx concurrente lo creó y committeó primero) → createTrip debe lanzar ActiveTripExistsError.
  liveInTx: { id: string } | null = null,
) {
  let store = initial;
  const outbox: PublishedEvent[] = [];
  const tripEvents: { eventType: string; payload: unknown }[] = [];

  const tx = {
    // RC23 · re-check in-tx del invariante "un solo viaje vivo" bajo advisory lock. En estos dobles no hay
    // concurrencia real ni viaje vivo previo → el lock es no-op y findFirst devuelve null (no bloquea el create).
    $executeRaw: async () => 0,
    trip: {
      // RC23 · guard in-tx (post-lock): sin viaje vivo previo en el doble → null. El test dedicado del 409
      // in-tx sobreescribe esta rama para simular que otra tx creó un viaje vivo entre el check y el create.
      findFirst: async () => liveInTx,
      create: async ({ data }: { data: Partial<Trip> }) => {
        store = buildTrip(data);
        return store;
      },
      update: async ({ data }: { data: Partial<Trip> }) => {
        store = buildTrip({ ...(store ?? {}), ...data });
        return store;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where?: {
          status?: TripStatus | { in: readonly TripStatus[] };
          agreedFareCents?: number | null;
          negotiationSeq?: number;
          fareCents?: number;
        };
        data: Partial<Trip>;
      }) => {
        // CAS de changeDestination (ADR-022 A3): el WHERE lleva `fareCents`. Modo carrera: mutamos el store
        // (otro escritor ganó) y devolvemos count 0. Si no, honramos el CAS optimista (fareCents debe coincidir).
        if (where?.fareCents !== undefined) {
          if (raceOnDestinationCas) {
            store = buildTrip({ ...(store ?? {}), ...raceOnDestinationCas });
            return { count: 0 };
          }
          if (store?.fareCents !== where.fareCents) return { count: 0 };
        }
        // Guard de carrera (activateScheduledTrip, expireFromNoOffers, rebid): si el where exige un
        // status concreto y el store YA no está en él (otro tap ganó), no toca fila → count 0 (idempotente).
        // N9: applyAgreedFare usa `status: { in: [...] }` (no-terminal) — soportamos ambas formas.
        if (where?.status !== undefined) {
          const current = store?.status;
          const matches =
            typeof where.status === 'object'
              ? current !== undefined && where.status.in.includes(current)
              : current === where.status;
          if (!matches) return { count: 0 };
        }
        // H13 — guard de CICLO de negociación de applyAgreedFare: si el where exige un seq y el store está
        // en OTRO ciclo (redelivery stale de un ciclo viejo), no toca fila → count 0 (no escribe tarifa rancia).
        if (where?.negotiationSeq !== undefined && store?.negotiationSeq !== where.negotiationSeq) {
          return { count: 0 };
        }
        // Guard idempotente-por-evento de applyAgreedFare (N7): solo aplica si agreedFareCents SIGUE null.
        if (
          where?.agreedFareCents !== undefined &&
          (store?.agreedFareCents ?? null) !== where.agreedFareCents
        ) {
          return { count: 0 };
        }
        store = buildTrip({ ...(store ?? {}), ...data });
        return { count: 1 };
      },
      // D1 (CAS atómico de assign): tras el updateMany guardado, el service relee el viaje DENTRO de la
      // misma tx (findUnique para el estado observado; findUniqueOrThrow para devolver la fila ya escrita).
      findUnique: async () => store,
      findUniqueOrThrow: async () => {
        if (!store) throw new Error('Trip no encontrado (mock findUniqueOrThrow)');
        return store;
      },
    },
    tripEvent: {
      create: async ({ data }: { data: { eventType: string; payload: unknown } }) => {
        tripEvents.push({ eventType: data.eventType, payload: data.payload });
        return {};
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { eventType: string; envelope: unknown } }) => {
        outbox.push({
          eventType: data.eventType,
          envelope: data.envelope as PublishedEvent['envelope'],
        });
        return {};
      },
    },
  };

  const prisma = {
    read: {
      trip: {
        findUnique: async () => store,
      },
    },
    write: {
      trip: {
        findUnique: async () => store,
        // Guard "un solo viaje vivo" de createTrip (ADR 010): lee del primario el viaje LIVE del
        // pasajero. En estos dobles no hay viaje vivo previo → null (no bloquea la creación).
        findFirst: async () => null,
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    _outbox: outbox,
    _tripEvents: tripEvents,
    get _store() {
      return store;
    },
  };
  return prisma;
}

const maps = {
  route: async () => ({
    distanceMeters: 5000,
    durationSeconds: 600,
    polyline: 'xyz',
    geometry: { type: 'LineString' as const, coordinates: [] },
  }),
  routeWithSteps: async () => ({
    distanceMeters: 5000,
    durationSeconds: 600,
    polyline: 'xyz',
    geometry: { type: 'LineString' as const, coordinates: [] },
    steps: [],
  }),
  eta: async () => 600,
  // MapsClient.etaBatch (A1): un ETA por origen, alineado. El mock devuelve 600 por cada origen.
  etaBatch: async (origins: readonly unknown[]) => origins.map(() => 600),
  geocode: async () => null,
  autocomplete: async () => [],
  reverse: async () => null,
};

/**
 * B · Redis falso en memoria para el lockout anti-brute-force del código de modo niño. Solo implementa
 * lo que TripsService usa (get/incr/expire/set/del). No modela TTL en el tiempo (no hace falta para los
 * tests deterministas: el lock vive hasta que se borra o termina el test).
 */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async (_key: string, _seconds: number) => 1,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    },
    del: async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
    _store: store,
  };
}

const baseCreateDto = {
  passengerId: '11111111-1111-1111-1111-111111111111',
  origin: { lat: -12.0464, lon: -77.0428 },
  destination: { lat: -12.1219, lon: -77.0297 },
  paymentMethod: PaymentMethod.YAPE,
};

describe('TripsService.createTrip · BR-T05 + outbox', () => {
  it('crea en REQUESTED, calcula tarifa real y encola trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.status).toBe(TripStatus.REQUESTED);
    // 600 + 120*5 + 30*10 = 1500
    expect(view.fareCents).toBe(1500);
    const requested = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    expect(requested).toBeTruthy();
    // ADR 011 M1: sin bid ⇒ dispatchMode FIXED persistido en la fila.
    expect(prisma._store?.dispatchMode).toBe('FIXED');
  });

  it('es idempotente por Idempotency-Key (no duplica)', async () => {
    const existing = buildTrip({ idempotencyKey: 'key-123', fareCents: 999 });
    const prisma = makePrisma(existing);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto }, 'key-123');
    expect(view.fareCents).toBe(999);
    // No se encoló ningún evento nuevo (devolvió el existente).
    expect(prisma._outbox).toHaveLength(0);
  });

  it('RC23 · un viaje vivo que aparece ENTRE el fast-fail y el create (carrera) → 409 in-tx, NO doble viaje', async () => {
    // El gate de arriba (fuera de la tx) devuelve null (no había viaje vivo al chequear), pero para cuando la tx
    // toma el advisory lock otra tx concurrente YA creó y committeó un viaje vivo del mismo pasajero. El re-check
    // in-tx (post-lock) lo encuentra → ActiveTripExistsError con el activeTripId. Sin este re-check nacerían DOS.
    const prisma = makePrisma(null, undefined, { id: 'trip-vivo-concurrente' });
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.createTrip({ ...baseCreateDto })).rejects.toBeInstanceOf(ActiveTripExistsError);
    // No se creó ni encoló nada: la tx abortó antes del create (el store sigue vacío).
    expect(prisma._store).toBeNull();
    expect(prisma._outbox).toHaveLength(0);
  });

  it('RC23 · una RESERVA (scheduledFor) NO toma el lock ni el re-check in-tx (varias reservas conviven)', async () => {
    // SCHEDULED no es "vivo" → el invariante de un-solo-viaje-vivo no aplica; aunque el fake tenga un liveInTx,
    // la rama scheduled NO entra al guard (if !scheduledFor) → la reserva se crea igual.
    const prisma = makePrisma(null, undefined, { id: 'otro-vivo' });
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const view = await svc.createTrip({ ...baseCreateDto, scheduledFor });
    expect(view.status).toBe(TripStatus.SCHEDULED);
  });

  it('modo niño sin código → ValidationError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.createTrip({ ...baseCreateDto, childMode: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('Ola 2B · scheduledFor futuro → SCHEDULED, registra trip.scheduled y NO emite trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const view = await svc.createTrip({ ...baseCreateDto, scheduledFor });
    expect(view.status).toBe(TripStatus.SCHEDULED);
    expect(view.scheduledFor).toBeTruthy();
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.scheduled')).toBe(true);
  });

  it('Ola 2B · scheduledFor demasiado pronto (<15min) → ValidationError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // +5min
    await expect(svc.createTrip({ ...baseCreateDto, scheduledFor: soon })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('Ola 2B · MOTO se propaga al evento trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.createTrip({ ...baseCreateDto, vehicleType: 'MOTO' });
    const requested = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    expect((requested?.envelope.payload as { vehicleType?: string }).vehicleType).toBe('MOTO');
  });

  it('Ola 2B · las paradas (waypoints) viajan en trip.requested (dispatch ya no queda ciego)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const stops = [
      { lat: -12.05, lon: -77.04 },
      { lat: -12.06, lon: -77.05 },
    ];
    await svc.createTrip({ ...baseCreateDto, waypoints: stops });
    const requested = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    expect((requested?.envelope.payload as { waypoints?: unknown }).waypoints).toEqual(stops);
  });

  it('Ola 2B · las paradas (waypoints) viajan en trip.bid_posted', async () => {
    const prisma = makePrisma(null);
    // ADR 023: la PUJA la determina la oferta → catálogo con la oferta pineada a PUJA.
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      fakeCatalog({ mode: PricingMode.PUJA }),
    );
    const stops = [{ lat: -12.07, lon: -77.06 }];
    await svc.createTrip({ ...baseCreateDto, bidCents: 900, waypoints: stops });
    const bid = prisma._outbox.find((e) => e.eventType === 'trip.bid_posted');
    expect((bid?.envelope.payload as { waypoints?: unknown }).waypoints).toEqual(stops);
  });

  it('ADR 013 · Fase B · oferta DESHABILITADA en el catálogo → OfferingUnavailableError (409)', async () => {
    const prisma = makePrisma(null);
    // Catálogo que reporta la oferta como apagada (admin la deshabilitó entre el quote y el create).
    const disabledCatalog = fakeCatalog({ enabled: false });
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      disabledCatalog,
    );
    await expect(svc.createTrip({ ...baseCreateDto })).rejects.toBeInstanceOf(
      OfferingUnavailableError,
    );
    // No persistió el viaje (rechazó antes de crear).
    expect(prisma._store).toBeNull();
  });

  it('ADR 013 · Fase B · catálogo HABILITA la oferta → createTrip procede normal', async () => {
    const prisma = makePrisma(null);
    const enabledCatalog = fakeCatalog({ enabled: true });
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      enabledCatalog,
    );
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.status).toBe(TripStatus.REQUESTED);
  });

  it('ADR 013 · Fase B · degradación honesta: si el catálogo FALLA, createTrip PERMITE el viaje', async () => {
    const prisma = makePrisma(null);
    const brokenCatalog = fakeCatalog({ throws: true });
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      brokenCatalog,
    );
    const before = await readCatalogDegraded('create');
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.status).toBe(TripStatus.REQUESTED);
    // #2 observabilidad: la degradación silenciosa para el usuario es VISIBLE para Ops.
    expect(await readCatalogDegraded('create')).toBe(before + 1);
  });

  it('B5-4 · una VERTICAL oculta (defaultEnabled:false) NO se crea ni con el catálogo CAÍDO (no leak)', async () => {
    const prisma = makePrisma(null);
    const brokenCatalog = fakeCatalog({ throws: true });
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      brokenCatalog,
    );
    // Request crafteado: category de una vertical oculta + catálogo caído. La UI nunca la ofrece; el
    // server tampoco la deja crear (sin confirmar que el admin la habilitó) → 409, sin persistir.
    await expect(
      svc.createTrip({ ...baseCreateDto, category: OfferingId.VEO_AMBULANCE }),
    ).rejects.toBeInstanceOf(OfferingUnavailableError);
    expect(prisma._store).toBeNull();
  });

  it('ADR 023 · el admin PINEA el modo PUJA de la oferta → el viaje es PUJA (palanca manual)', async () => {
    const prisma = makePrisma(null);
    // La oferta nace FIXED en código; el admin la pineó a PUJA (overlay) → el modo EFECTIVO es PUJA. Con
    // bid válido, el viaje abre OfferBoard (trip.bid_posted), no el matching secuencial (trip.requested).
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      fakeCatalog({ mode: PricingMode.PUJA }),
    );
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.dispatchMode).toBe('PUJA');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true); // PUJA
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false); // no FIXED
  });

  it('B2 · el override de multiplier del admin sube la tarifa FIXED (×2.0 → fareCents 3000)', async () => {
    const prisma = makePrisma(null);
    // FIXED por default (oferta FIXED, sin bid). calculateFare(5000m,600s)=1500; ×2.0=3000 (> minFare 500).
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      fakeCatalog({ multiplier: 2.0 }),
    );
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.fareCents).toBe(3000);
  });
});

describe('ScheduledTripService · Ola 2B viajes programados (activación / cancelación)', () => {
  it('activateScheduledTrip · FIXED transiciona SCHEDULED → REQUESTED y emite trip.requested (ADR 011)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'FIXED' }),
    );
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never));
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
  });

  it('activateScheduledTrip · PUJA respeta el dispatchMode congelado → emite trip.bid_posted (ADR 011 §1.2)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'PUJA' }),
    );
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never));
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
  });

  it('activateScheduledTrip es idempotente si ya no está SCHEDULED', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never));
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox).toHaveLength(0);
  });

  it('cancelScheduledTrip sin penalidad (→ CANCELLED_BY_PASSENGER, penaltyCents 0)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), passengerId: 'pax-1' }),
    );
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never));
    const view = await svc.cancelScheduledTrip('trip-1', 'pax-1');
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(view.penaltyCents).toBe(0);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('cancelScheduledTrip sobre un viaje ya activado → ConflictError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED, passengerId: 'pax-1' }));
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never));
    await expect(svc.cancelScheduledTrip('trip-1', 'pax-1')).rejects.toBeInstanceOf(ConflictError);
  });

  // ADR 013 · Fase B — la oferta del programado se deshabilita entre la reserva y la activación.
  it('activateScheduledTrip · oferta DESHABILITADA → EXPIRED + trip.expired (no abre dispatch)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.SCHEDULED,
        scheduledFor: new Date(),
        dispatchMode: 'FIXED',
        passengerId: 'pax-1',
      }),
    );
    const catalog = { isEnabled: async () => false };
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never), undefined, undefined, catalog as never);
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
  });

  it('activateScheduledTrip · catálogo CAÍDO → activa igual (degradación honesta, no aborta el viaje)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'FIXED' }),
    );
    const catalog = {
      isEnabled: async () => {
        throw new Error('catalog down');
      },
    };
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never), undefined, undefined, catalog as never);
    const before = await readCatalogDegraded('activate');
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(false);
    // #2 observabilidad: catálogo caído al activar → métrica visible (site=activate).
    expect(await readCatalogDegraded('activate')).toBe(before + 1);
  });

  it('activateScheduledTrip · oferta REMOVIDA del código (resolve lanza) → EXPIRED (sin poison-loop)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.SCHEDULED,
        scheduledFor: new Date(),
        category: 'veo_removido',
        passengerId: 'pax-1',
      }),
    );
    const catalog = { isEnabled: async () => true };
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never), undefined, undefined, catalog as never);
    await svc.activateScheduledTrip('trip-1'); // no debe lanzar
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
  });

  it('activateScheduledTrip · oferta HABILITADA → activa normal (SCHEDULED → REQUESTED)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'FIXED' }),
    );
    const catalog = { isEnabled: async () => true };
    const svc = new ScheduledTripService(new ScheduledTripRepository(prisma as never), undefined, undefined, catalog as never);
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(false);
  });
});

describe('TripsService · BR-T02 guardas de transición', () => {
  it('assignFromDispatch es idempotente si ya está ASSIGNED con el mismo conductor', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-9' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.assignFromDispatch('trip-1', 'drv-9');
    expect(prisma._outbox).toHaveLength(0); // no reprocesa
  });

  it('N10: assignFromDispatch sobre un viaje TERMINAL → ACK no-op (NO lanza, sin poison-loop)', async () => {
    // Un match_found re-emitido (reconciler de dispatch / redelivery) llega DESPUÉS de que el viaje murió.
    // Materializar ASSIGNED es imposible; si lanzáramos, el consumer Kafka haría no-ack → retry INFINITO.
    // El handler debe tolerarlo: NO lanza (el consumer ACK-ea) y NO emite ningún trip.assigned.
    for (const status of [
      TripStatus.CANCELLED_BY_PASSENGER,
      TripStatus.CANCELLED_BY_DRIVER,
      TripStatus.EXPIRED,
      TripStatus.FAILED,
      TripStatus.COMPLETED,
    ]) {
      const prisma = makePrisma(buildTrip({ status, driverId: null }));
      const svc = new TripsService(new TripsRepository(prisma as never), maps);
      // La prueba del no-poison: NO debe lanzar (resolves), de lo contrario kafkajs reintentaría infinito.
      await expect(svc.assignFromDispatch('trip-1', 'drv-9')).resolves.toBeUndefined();
      expect(prisma._store?.status).toBe(status); // el viaje muerto NO cambió de estado
      expect(prisma._outbox).toHaveLength(0); // NO se emitió trip.assigned
    }
  });

  it('N10: assignFromDispatch sobre un viaje ACTIVO (REQUESTED) → SÍ asigna — contraste', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.assignFromDispatch('trip-1', 'drv-9');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._store?.driverId).toBe('drv-9');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.assigned')).toBe(true);
  });

  it('getTrip inexistente → NotFoundError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripQueryService(new TripQueryRepository(prisma as never));
    await expect(svc.getTrip('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── CAS atómico: las 7 transiciones de usuario lanzan 409 ante una carrera que ya pisó un terminal ──
//
// Cada test mete el store en un estado terminal/inválido para la transición y verifica que (a) lanza
// InvalidTripTransition y (b) NO se emite el evento al outbox. El guard real es el `status` en el WHERE
// del updateMany (casTransition): aunque el assertTransition pre-tx pasara por una carrera, el claim
// fallaría. Espeja el test de `assign sobre un viaje COMPLETED`. CRÍTICOS: complete (no cobra) y cancel
// (no procesa el split) sobre un viaje ya muerto.
describe('TripsService · BR-T02 CAS atómico — las 7 transiciones de usuario lanzan 409 ante carrera', () => {
  const DRV = '22222222-2222-2222-2222-222222222222';

  it('acceptTrip sobre un viaje CANCELLED_BY_PASSENGER → InvalidTripTransition, NO emite trip.accepted', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.acceptTrip('trip-1', { driverId: DRV })).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.accepted')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
  });

  it('arriving sobre un viaje CANCELLED_BY_PASSENGER → InvalidTripTransition, NO emite trip.arriving', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.arriving('trip-1', { driverId: DRV })).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.arriving')).toBe(false);
  });

  it('arrived sobre un viaje CANCELLED_BY_PASSENGER → InvalidTripTransition, NO emite trip.arrived', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.arrived('trip-1', { driverId: DRV })).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.arrived')).toBe(false);
  });

  it('start sobre un viaje CANCELLED_BY_PASSENGER → InvalidTripTransition, NO emite trip.started', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.start('trip-1', { driverId: DRV })).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.started')).toBe(false);
  });

  it('CRÍTICO complete sobre un viaje CANCELLED_BY_PASSENGER → InvalidTripTransition, NO emite trip.completed (no cobra)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.complete('trip-1', { driverId: DRV })).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.completed')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
  });

  it('CRÍTICO cancel sobre un viaje COMPLETED → InvalidTripTransition, NO emite trip.cancelled (no procesa split)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.COMPLETED, passengerId: 'pax-1', driverId: DRV }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.cancel('trip-1', { by: 'PASSENGER' }, userOf('pax-1'))).rejects.toBeInstanceOf(
      InvalidTripTransition,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.COMPLETED);
  });

  // failAfterTooManyReassigns (#7): la rama es PRIVADA y se alcanza vía `cancel` del conductor POST-accept
  // con reassignCount en el tope. Con el mock de store ÚNICO no se puede expresar "read ve ACCEPTED, CAS ve
  // terminal" (findUnique y updateMany leen el MISMO store: el routing a la rama fail depende del read). Por
  // eso aquí cubrimos las dos garantías que SÍ son expresables:
  //   (a) ruta feliz: deriva a FAILED por el CAS y emite trip.failed (NO trip.reassigning) — prueba el CAS nuevo;
  //   (b) garantía de carrera: el dispatchModes registry no está cableado en este doble, así que el camino
  //       REASSIGNING (no-fail) lanzaría; por eso fijamos reassignCount=maxReassign para forzar SOLO la rama fail.
  it('failAfterTooManyReassigns: cancel del conductor POST-accept con tope superado → FAILED vía CAS, emite trip.failed y NO trip.reassigning', async () => {
    // maxReassign default = 3; con reassignCount 3, nextReassignCount 4 > 3 → failAfterTooManyReassigns.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, driverId: DRV, reassignCount: 3 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel(
      'trip-1',
      { by: 'DRIVER', driverId: DRV, reason: 'x' },
      DRIVER_USER,
    );
    expect(view.status).toBe(TripStatus.FAILED);
    expect(prisma._store?.status).toBe(TripStatus.FAILED);
    expect(prisma._store?.driverId).toBeNull(); // el conductor que canceló se desvincula
    expect(prisma._outbox.some((e) => e.eventType === 'trip.failed')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
  });

  it('failAfterTooManyReassigns: si una carrera ya llevó el viaje a un terminal, el cancel del conductor lanza InvalidTripTransition y NO emite trip.failed', async () => {
    // Store ya CANCELLED_BY_PASSENGER: mustFind lo ve terminal → NO entra a POST_ACCEPT_STATES → cae al
    // cancel normal (target CANCELLED_BY_DRIVER), cuyo assertTransition pre-tx ya lanza (terminal sin
    // salidas). Garantía de fondo idéntica: viaje muerto ⇒ 409 y CERO eventos al outbox.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER, driverId: DRV, reassignCount: 3 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.cancel('trip-1', { by: 'DRIVER', driverId: DRV, reason: 'x' }, DRIVER_USER),
    ).rejects.toBeInstanceOf(InvalidTripTransition);
    expect(prisma._outbox).toHaveLength(0);
  });
});

describe('TripsService.start · BR-T07 modo niño', () => {
  it('código correcto inicia el viaje (→ IN_PROGRESS) y emite trip.started', async () => {
    const hash = bcrypt.hashSync('1234', 10);
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: hash,
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.start('trip-1', { childCode: '1234' });
    expect(view.status).toBe(TripStatus.IN_PROGRESS);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.started')).toBe(true);
  });

  it('código incorrecto NO avanza, emite alerta trip.child_code_failed y lanza ValidationError', async () => {
    const hash = bcrypt.hashSync('1234', 10);
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: hash,
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.start('trip-1', { childCode: '9999' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prisma._outbox.some((e) => e.eventType === 'trip.child_code_failed')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.started')).toBe(false);
    // el estado no avanzó
    expect(prisma._store?.status).toBe(TripStatus.ARRIVED);
  });

  // CONTRATO evento↔schema (dominó S3): el gate de @veo/events (KafkaEventConsumer) DESCARTA en
  // silencio todo payload que no pase el schema del registro central, y el relay del outbox lo
  // PUBLICA con `schema.parse` (lanza). Si el payload REAL que emite el producer no pasa el
  // `safeParse` del schema REGISTRADO, el evento jamás llega al handler de notification (código
  // muerto) o, peor, envenena el outbox. Este spec es el que faltaba en la ronda 1.
  it('CONTRATO: el payload REAL de trip.child_code_failed pasa el schema del registro central', async () => {
    const hash = bcrypt.hashSync('1234', 10);
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: hash,
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.start('trip-1', { childCode: '9999', driverId: 'drv-1' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const emitted = prisma._outbox.find((e) => e.eventType === 'trip.child_code_failed');
    expect(emitted).toBeTruthy();
    expect(
      EVENT_SCHEMAS['trip.child_code_failed'].safeParse(emitted!.envelope.payload).success,
    ).toBe(true);
    const payload = emitted!.envelope.payload as {
      tripId: string;
      passengerId?: string;
      driverId?: string;
      attempt?: number;
      at: string;
    };
    // attempt SIEMPRE viaja (el registro lo tolera ausente SOLO por filas pre-fix del outbox); sin
    // Redis degrada honesto a 1 ("al menos este intento").
    expect(payload.attempt).toBe(1);
    // passengerId enriquecido: destinatario del push crítico al padre/madre (sin él, notification
    // degrada honesto y NO hay alerta).
    expect(payload.passengerId).toBe('pax-1');
    expect(payload.driverId).toBe('drv-1');
  });

  it('viaje con modo niño sin código → ValidationError', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: bcrypt.hashSync('1234', 10),
        driverId: 'd',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.start('trip-1', {})).rejects.toBeInstanceOf(ValidationError);
  });

  // A1 · anti-IDOR (ownership server-side; el driver-bff deriva el driverId y lo manda)
  it('start con driverId AJENO → 404 (no inicia ni prueba el código del viaje de otro conductor)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: bcrypt.hashSync('1234', 10),
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.start('trip-1', { childCode: '1234', driverId: 'drv-OTRO' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // No avanzó ni emitió nada (ni siquiera el child_code_failed): el viaje ajeno es "inexistente".
    expect(prisma._store?.status).toBe(TripStatus.ARRIVED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('start con el driverId PROPIO → inicia ok (contraste anti-IDOR)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: bcrypt.hashSync('1234', 10),
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' });
    expect(view.status).toBe(TripStatus.IN_PROGRESS);
  });
});

// A1 · anti-IDOR en las transiciones PRE-RECOJO del conductor (cierre del write-IDOR de auditoría): un
// conductor con un tripId ajeno NO puede dispararle accept/arriving/arrived. El driver-bff deriva el
// driverId del perfil y lo manda; trip-service lo verifica acá (404, no filtra existencia ajena).
describe('TripsService · A1 anti-IDOR pre-recojo (accept/arriving/arrived)', () => {
  it('acceptTrip con driverId AJENO → 404 (no avanza el viaje de otro conductor)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.acceptTrip('trip-1', { driverId: 'drv-OTRO' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('acceptTrip con driverId PROPIO → ACCEPTED ok (contraste)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.acceptTrip('trip-1', { driverId: 'drv-1' });
    expect(view.status).toBe(TripStatus.ACCEPTED);
  });

  it('arriving con driverId AJENO → 404', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.arriving('trip-1', { driverId: 'drv-OTRO' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(prisma._store?.status).toBe(TripStatus.ACCEPTED);
  });

  it('arrived con driverId AJENO → 404', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ARRIVING, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.arrived('trip-1', { driverId: 'drv-OTRO' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(prisma._store?.status).toBe(TripStatus.ARRIVING);
  });
});

describe('TripsService.start · B · lockout anti-brute-force del código de modo niño (Redis)', () => {
  function build(redis: ReturnType<typeof makeRedis>) {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ARRIVED,
        childMode: true,
        childCodeHash: bcrypt.hashSync('1234', 10),
        driverId: 'drv-1',
      }),
    );
    // constructor (ADR 023): (prisma, maps, config?, redis?, dispatchModes?, catalog?, …) — redis va 4º.
    const svc = new TripsService(new TripsRepository(prisma as never), maps, undefined, redis as never);
    return { prisma, svc };
  }

  it('5 intentos fallidos → el 6º queda BLOQUEADO con 429 (RateLimitError)', async () => {
    const redis = makeRedis();
    const { svc, prisma } = build(redis);
    // 5 intentos con código incorrecto: cada uno lanza ValidationError (no bloqueo todavía).
    for (let i = 0; i < 5; i += 1) {
      await expect(
        svc.start('trip-1', { childCode: '9999', driverId: 'drv-1' }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    // tras 5 fallos el candado está echado: el 6º intento (aunque mande el código CORRECTO) → 429.
    await expect(
      svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(redis._store.get('childcode:lock:trip-1')).toBe('1');
    // CONTRATO: cada alerta emitida lleva el Nº de intento REAL del contador (1..5) y pasa el schema
    // del registro central (si no, el gate del consumer la descartaría en silencio).
    const failures = prisma._outbox.filter((e) => e.eventType === 'trip.child_code_failed');
    expect(failures.map((e) => (e.envelope.payload as { attempt?: number }).attempt)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    for (const e of failures) {
      expect(EVENT_SCHEMAS['trip.child_code_failed'].safeParse(e.envelope.payload).success).toBe(
        true,
      );
    }
  });

  it('un acierto ANTES del tope resetea el contador y el candado (DEL)', async () => {
    const redis = makeRedis();
    const { svc } = build(redis);
    // 3 fallos (contador en 3, sin candado aún).
    for (let i = 0; i < 3; i += 1) {
      await expect(
        svc.start('trip-1', { childCode: '9999', driverId: 'drv-1' }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(redis._store.get('childcode:attempts:trip-1')).toBe('3');
    // acierto → resetea contador y candado.
    const view = await svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' });
    expect(view.status).toBe(TripStatus.IN_PROGRESS);
    expect(redis._store.has('childcode:attempts:trip-1')).toBe(false);
    expect(redis._store.has('childcode:lock:trip-1')).toBe(false);
  });

  it('un viaje YA bloqueado rechaza con 429 ANTES de comparar el código', async () => {
    const redis = makeRedis();
    const { svc } = build(redis);
    redis._store.set('childcode:lock:trip-1', '1'); // candado pre-existente
    await expect(
      svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('TripsService.changeDestination · BR-T01 tarifa inmutable salvo cambio aprobado', () => {
  it('recalcula y persiste la tarifa, registrando trip_event', async () => {
    const longRoute = {
      route: async () => ({
        distanceMeters: 10000,
        durationSeconds: 1200,
        polyline: 'new',
        geometry: { type: 'LineString' as const, coordinates: [] },
      }),
      routeWithSteps: async () => ({
        distanceMeters: 10000,
        durationSeconds: 1200,
        polyline: 'new',
        geometry: { type: 'LineString' as const, coordinates: [] },
        steps: [],
      }),
      eta: async () => 1200,
      etaBatch: async (origins: readonly unknown[]) => origins.map(() => 1200),
      geocode: async () => null,
      autocomplete: async () => [],
      reverse: async () => null,
    };
    const prisma = makePrisma(buildTrip({ status: TripStatus.ACCEPTED, fareCents: 1500 }));
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute);
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    // 600 + 120*10 + 30*20 = 600 + 1200 + 600 = 2400
    expect(view.fareCents).toBe(2400);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.destination_changed')).toBe(true);
  });

  it('no permite cambiar destino una vez IN_PROGRESS (tarifa inmutable)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.IN_PROGRESS }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // El re-quote del destino aplica la política de la oferta del viaje (multiplier + mínima).
  const longRoute10k = {
    route: async () => ({
      distanceMeters: 10000,
      durationSeconds: 1200,
      polyline: 'new',
      geometry: { type: 'LineString' as const, coordinates: [] },
    }),
  };

  it('FIXED: re-cotiza con la política de la oferta, no resetea a la fórmula base (confort ×1.25 → 3000)', async () => {
    // Confort (×1.25), ruta 10 km/20 min: servicio 2400 × 1.25 = 3000. SIN política, calculateFare base daba 2400.
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        dispatchMode: 'FIXED',
        category: 'veo_confort',
        fareCents: 3000,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    expect(view.fareCents).toBe(3000);
  });

  it('ADR-022 A3 · PUJA: cambiar destino NO cobra por DEBAJO del bid acordado (piso al fareCents)', async () => {
    // PUJA con bid acordado 2600. Ruta 10 km/Económico ×1.0 → fórmula = 600 + 120·10 + 30·20 = 2400 (< bid).
    // SIN el piso, changeDestination bajaba el cobro a 2400 (el pasajero pagaba menos que lo NEGOCIADO); con el
    // piso A3 se mantiene 2600 (el conductor aceptó ese precio, no se regala plata reseteando hacia abajo).
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'PUJA', fareCents: 2600 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    expect(view.fareCents).toBe(2600);
  });

  it('ADR-022 changeDest · el audit trip.destination_changed graba el fareCents FLOOREADO (lo cobrado), no el recompute crudo', async () => {
    // PUJA bid 2600, recompute 2400 (< bid) → se persiste/cobra 2600 (piso A3). El log append-only (Ley 29733)
    // DEBE registrar 2600 y previousFareCents 2600 — antes grababa fare.cents crudo (2400) → el audit mentía
    // ±S/2.00 en el caso que el piso protege.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'PUJA', fareCents: 2600 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    const event = prisma._tripEvents.find((e) => e.eventType === 'trip.destination_changed');
    expect(event?.payload).toMatchObject({ fareCents: 2600, previousFareCents: 2600 });
  });

  it('RC5 · changeDestination PUBLICA trip.destination_changed al OUTBOX (antes solo grababa audit interno)', async () => {
    // El bug: era el ÚNICO mutador significativo que NO emitía al outbox → la familia (share-service) nunca se
    // enteraba y el destino de un menor se cambiaba en silencio. Ahora publica: notification alerta al guardián.
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        dispatchMode: 'FIXED',
        fareCents: 2400,
        childMode: true,
        passengerId: 'guardian-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });

    const emitted = prisma._outbox.find((e) => e.eventType === 'trip.destination_changed');
    expect(emitted).toBeTruthy(); // se publicó al outbox (no solo el trip_event interno)
    expect(emitted!.envelope.payload).toMatchObject({
      tripId: 'trip-1',
      passengerId: 'guardian-1',
      childMode: true, // viaja para que notification priorice la alerta al guardián (seguridad del menor)
    });
  });

  it('ADR-022 changeDest · re-cotiza con el pricing EFECTIVO del admin (overlay), no el catálogo de código', async () => {
    // Económico base ×1.0 → 2400 (ruta 10km/20min). El admin subió el multiplier a ×1.5 por overlay →
    // 2400 × 1.5 = 3600. SIN el fix, changeDestination usaba offering.pricing de código (×1.0) → 2400,
    // incoherente con el create (que sí usa el overlay). El fix lo alinea vía resolveEffectiveOffering.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'FIXED', fareCents: 2400 }),
    );
    const catalog = {
      resolveOffering: async () => ({ enabled: true, pricing: { multiplier: 1.5, minFareCents: 500 } }),
    } as never;
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      longRoute10k as never,
      undefined, // config
      undefined, // redis
      undefined, // dispatchModes
      catalog, // CatalogService (posición 6)
    );
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    expect(view.fareCents).toBe(3600);
  });

  it('ADR-022 changeDest · una oferta DESHABILITADA por el admin NO rompe el cambio de destino (mid-viaje, enforceEnabled:false)', async () => {
    // El create tira 409 si el admin deshabilitó la oferta; mid-viaje el viaje YA existe → el cambio de destino
    // debe seguir andando con el pricing del overlay, sin gate de enabled.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'FIXED', fareCents: 2400 }),
    );
    const catalog = {
      resolveOffering: async () => ({ enabled: false, pricing: { multiplier: 1.0, minFareCents: 500 } }),
    } as never;
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      longRoute10k as never,
      undefined, // config
      undefined, // redis
      undefined, // dispatchModes
      catalog, // CatalogService (posición 6)
    );
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    expect(view.fareCents).toBe(2400); // no lanza; usa el pricing del overlay (×1.0 acá)
  });

  it('ADR-022 A3 · CAS: carrera que sacó el viaje de un estado editable → ConflictError reason=status_not_editable', async () => {
    // El viaje era editable al leerse, pero entre el re-read in-tx y el write un start/cancel lo movió.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'PUJA', fareCents: 2600 }),
      { status: TripStatus.IN_PROGRESS },
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    await expect(
      svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } }),
    ).rejects.toMatchObject({ details: { reason: 'status_not_editable' } });
  });

  it('ADR-022 A3 · CAS: carrera de re-puja (fareCents cambió) → ConflictError reason=fare_changed (retryable), NO "estado actual"', async () => {
    // El bid subió (re-puja aceptada) entre el re-read y el write: el CAS sobre fareCents falla. El caller debe
    // poder distinguir esto (reintentar con el bid nuevo) de un estado no-editable (rendirse).
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, dispatchMode: 'PUJA', fareCents: 2600 }),
      { fareCents: 3000 }, // otro escritor subió el bid; el estado sigue editable
    );
    const svc = new TripsService(new TripsRepository(prisma as never), longRoute10k as never);
    await expect(
      svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } }),
    ).rejects.toMatchObject({ details: { reason: 'fare_changed', currentFareCents: 3000 } });
  });
});

describe('TripsService.cancel · BR-T03', () => {
  it('cancelación del pasajero tras la gracia con conductor puntual → penaliza S/3', async () => {
    const assignedAt = new Date(Date.now() - 5 * 60_000); // 5 min atrás
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        assignedAt,
        driverId: 'drv-1',
        durationSeconds: 3600,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel(
      'trip-1',
      { by: 'PASSENGER', reason: 'cambié de planes' },
      userOf('pax-1'),
    );
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(view.penaltyCents).toBe(300);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('cancelación del pasajero dentro de la gracia (< 2 min) → sin penalización', async () => {
    const assignedAt = new Date(Date.now() - 30_000); // 30s atrás
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, assignedAt, driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'PASSENGER' }, userOf('pax-1'));
    expect(view.penaltyCents).toBe(0);
  });

  // A1 · anti-IDOR (ownership server-side, defensa en profundidad)
  it('PASSENGER con passengerId AJENO → 404 (no cancela el viaje de otro)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, passengerId: 'pax-1', driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.cancel('trip-1', { by: 'PASSENGER', passengerId: 'pax-OTRO' }, userOf('pax-OTRO')),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(false);
  });

  it('PASSENGER con su PROPIO passengerId → cancela ok', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, passengerId: 'pax-1', driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel(
      'trip-1',
      { by: 'PASSENGER', passengerId: 'pax-1' },
      userOf('pax-1'),
    );
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
  });

  it('A1 · anti-IDOR sin passengerId en el body: usa el userId FIRMADO → ajeno = 404 (ya no se saltea)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, passengerId: 'pax-1', driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    // Antes, sin dto.passengerId el check se SALTEABA; ahora el dueño es la identidad firmada.
    await expect(
      svc.cancel('trip-1', { by: 'PASSENGER' }, userOf('pax-OTRO')),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(false);
  });
});

// ──────────────────────────── PUJA (ADR 010 · Lote C) ────────────────────────────

describe('TripsService.createTrip · PUJA · el bid es el fareCents (ADR 010 §2 · ADR 023)', () => {
  // ADR 023: el modo vive POR OFERTA. Para probar la mecánica de la PUJA el catálogo pinea la oferta a PUJA
  // (palanca manual del admin); sin catálogo la oferta nace FIXED y el bid se IGNORA.
  const pujaCatalog = () => fakeCatalog({ mode: PricingMode.PUJA });
  const pujaSvc = (prisma: unknown) =>
    new TripsService(new TripsRepository(prisma as never), maps, undefined, undefined, undefined, pujaCatalog());

  it('rechaza un bid por debajo del piso global (ValidationError)', async () => {
    const prisma = makePrisma(null);
    const svc = pujaSvc(prisma);
    // piso default S/7 = 700; bid 500 < 700 → rechazo
    await expect(svc.createTrip({ ...baseCreateDto, bidCents: 500 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('acepta un bid válido (≥ piso): fareCents = bid y emite trip.bid_posted (NO trip.requested)', async () => {
    const prisma = makePrisma(null);
    const svc = pujaSvc(prisma);
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900, vehicleType: 'MOTO' });
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(900); // el bid manda, NO la tarifa por ruta (1500)
    const bid = prisma._outbox.find((e) => e.eventType === 'trip.bid_posted');
    expect(bid).toBeTruthy();
    const payload = bid?.envelope.payload as {
      bidCents: number;
      windowSec: number;
      vehicleType: string;
    };
    expect(payload.bidCents).toBe(900);
    expect(payload.vehicleType).toBe('MOTO');
    expect(payload.windowSec).toBe(60); // default §9.1
    // El camino de puja NO emite el legacy trip.requested (no doble-dispatch).
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    // ADR 023: oferta PUJA ⇒ dispatchMode PUJA persistido en la fila.
    expect(prisma._store?.dispatchMode).toBe('PUJA');
  });

  it('bid exactamente en el piso (700) es válido', async () => {
    const prisma = makePrisma(null);
    const svc = pujaSvc(prisma);
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 700 });
    expect(view.fareCents).toBe(700);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('rechaza un bid por encima del techo (ValidationError, gate AUTORITATIVO anti-overflow int4)', async () => {
    const prisma = makePrisma(null);
    const svc = pujaSvc(prisma);
    // techo default BID_MAX_CENTS = 999_900; un bid desbocado overflowearía el int4 de fareCents.
    await expect(
      svc.createTrip({ ...baseCreateDto, bidCents: 9_999_999_999 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('bid exactamente en el techo (999_900) es válido', async () => {
    const prisma = makePrisma(null);
    const svc = pujaSvc(prisma);
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 999_900 });
    expect(view.fareCents).toBe(999_900);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('oferta FIXED (default de código) → tarifa por ruta y emite trip.requested (ignora el bid)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.fareCents).toBe(1500);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
  });
});

// ──────────────── ADR 023 · createTrip · el modo lo resuelve la OFERTA (no el cliente) ────────────────

describe('TripsService.createTrip · ADR 023 · el modo lo resuelve la OFERTA (no el cliente)', () => {
  const pujaCatalog = () => fakeCatalog({ mode: PricingMode.PUJA });

  it('oferta PUJA REQUIERE bidCents: si falta → 400 "falta tu oferta"', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps, undefined, undefined, undefined, pujaCatalog());
    // La oferta es PUJA pero el cliente NO mandó bid → ValidationError (HTTP 400).
    await expect(svc.createTrip({ ...baseCreateDto })).rejects.toMatchObject({
      httpStatus: 400,
      message: 'falta tu oferta',
    });
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('oferta PUJA con bidCents → emite trip.bid_posted y persiste dispatchMode PUJA', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps, undefined, undefined, undefined, pujaCatalog());
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.fareCents).toBe(900);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._store?.dispatchMode).toBe('PUJA');
  });

  it('oferta FIXED IGNORA bidCents, usa calculateFare y emite trip.requested (dispatchMode FIXED)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    // El cliente manda un bid, pero la oferta es FIXED → se IGNORA el bid; tarifa por ruta (1500).
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.fareCents).toBe(1500); // calculateFare, NO el bid de 900
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
    expect(prisma._store?.dispatchMode).toBe('FIXED');
  });

  // S1 (M5) — el modo CONGELADO viaja en la TripView (createTrip + getTrip) para que la app reconcilie.
  it('S1: la vista de createTrip expone dispatchMode = PUJA (oferta PUJA)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps, undefined, undefined, undefined, pujaCatalog());
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.dispatchMode).toBe('PUJA');
  });

  it('S1: la vista de createTrip expone dispatchMode = FIXED (oferta FIXED)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.dispatchMode).toBe('FIXED');
  });

  it('S1: getTrip también expone el dispatchMode congelado del viaje', async () => {
    const prisma = makePrisma(buildTrip({ dispatchMode: 'FIXED' }));
    const svc = new TripQueryService(new TripQueryRepository(prisma as never));
    const view = await svc.getTrip('trip-1');
    expect(view.dispatchMode).toBe('FIXED');
  });
});

describe('TripsService.applyAgreedFare · dispatch.offer_accepted (ADR 010 §4)', () => {
  it('fija fareCents = priceCents acordado (puede diferir del bid si fue COUNTER) y marca agreedFareCents', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.applyAgreedFare('trip-1', 1100, 1); // COUNTER aceptado
    expect(prisma._store?.fareCents).toBe(1100);
    // El agreed-fare queda registrado para el guard idempotente-por-evento (N7).
    expect(prisma._store?.agreedFareCents).toBe(1100);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });

  it('es idempotente por EVENTO: una redelivery del MISMO offer_accepted ya aplicado es no-op (N7)', async () => {
    // agreedFareCents ya seteado = el precio se aplicó una vez; reentregar el mismo evento no reescribe.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, agreedFareCents: 900 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._tripEvents).toHaveLength(0);
    expect(prisma._store?.fareCents).toBe(900);
  });

  it('N7: una redelivery del offer_accepted VIEJO tras un changeDestination NO revierte la tarifa', async () => {
    // Escenario del lost-update: el pasajero aceptó un COUNTER (fare=900, agreedFareCents=900) y LUEGO
    // un changeDestination recalculó la tarifa a 1200 (agreedFareCents intacto). Una redelivery
    // at-least-once del offer_accepted VIEJO (900) NO debe sobreescribir 1200 de vuelta a 900.
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ASSIGNED,
        fareCents: 1200,
        agreedFareCents: 900,
        driverId: 'drv-1',
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.applyAgreedFare('trip-1', 900, 1); // redelivery del precio viejo
    // La tarifa recalculada por changeDestination se mantiene; NO se revierte ni se emite fare_agreed.
    expect(prisma._store?.fareCents).toBe(1200);
    expect(prisma._tripEvents).toHaveLength(0);
  });

  it('N7: la PRIMERA aplicación funciona aunque fareCents ya coincida con priceCents (no es no-op por valor)', async () => {
    // Antes el guard por-valor (fareCents===priceCents) saltaba el marcado: el agreed-fare quedaba sin
    // registrar y una redelivery posterior podía corromper. Ahora la primera aplicación SIEMPRE marca.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, agreedFareCents: null }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._store?.agreedFareCents).toBe(900);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });

  it('rechaza un precio acordado por encima del techo (defensa en profundidad, no escribe fareCents)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.applyAgreedFare('trip-1', 9_999_999_999, 1)).rejects.toBeInstanceOf(
      ValidationError,
    );
    // La escritura de dinero NUNCA debe exceder el techo: fareCents queda intacto y no hay evento.
    expect(prisma._store?.fareCents).toBe(900);
    expect(prisma._tripEvents).toHaveLength(0);
  });

  it('N9: es NO-OP sobre un viaje TERMINAL (offer_accepted tardío no escribe fareCents ni emite fare_agreed)', async () => {
    // Un offer_accepted tardío/duplicado llega DESPUÉS de que el viaje ya murió (p.ej. CANCELLED). El
    // status-guard del updateMany impide escribir la tarifa o registrar trip.fare_agreed sobre un terminal.
    for (const status of [
      TripStatus.CANCELLED_BY_PASSENGER,
      TripStatus.CANCELLED_BY_DRIVER,
      TripStatus.EXPIRED,
      TripStatus.FAILED,
      TripStatus.COMPLETED,
    ]) {
      const prisma = makePrisma(buildTrip({ status, fareCents: 1500, agreedFareCents: null }));
      const svc = new TripsService(new TripsRepository(prisma as never), maps);
      await svc.applyAgreedFare('trip-1', 900, 1);
      expect(prisma._store?.fareCents).toBe(1500); // NO se escribió la tarifa acordada
      expect(prisma._store?.agreedFareCents).toBeNull(); // NO se marcó el agreed-fare
      expect(prisma._tripEvents).toHaveLength(0); // NO se emitió trip.fare_agreed
    }
  });

  it('N9: SÍ aplica sobre un viaje ACTIVO (no terminal) — contraste del status-guard', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, fareCents: 1500, agreedFareCents: null }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._store?.fareCents).toBe(900);
    expect(prisma._store?.agreedFareCents).toBe(900);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });
});

describe('TripsService.expireFromNoOffers · dispatch.no_offers → EXPIRED (ADR 010 §4/§5)', () => {
  it('transiciona REQUESTED → EXPIRED y emite trip.expired', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.expireFromNoOffers('trip-1', 'window_expired');
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
  });

  it('transiciona REASSIGNING → EXPIRED (re-puja sin ofertas)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REASSIGNING }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.expireFromNoOffers('trip-1', 'all_lapsed');
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
  });

  it('no-op idempotente si la puja ya cerró (p.ej. ya ASSIGNED)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.expireFromNoOffers('trip-1', 'window_expired');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox).toHaveLength(0);
  });
});

describe('TripsService.cancelFromBid · dispatch.bid_cancelled → CANCELLED_BY_PASSENGER (FIX cancel-puja)', () => {
  it('transiciona REQUESTED → CANCELLED_BY_PASSENGER + emite trip.cancelled (by PASSENGER, sin penalidad)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._store?.penaltyCents).toBe(0);
    const cancelled = prisma._outbox.find((e) => e.eventType === 'trip.cancelled');
    expect(cancelled).toBeTruthy();
    const payload = cancelled?.envelope.payload as {
      by: string;
      reason: string;
      penaltyCents: number;
    };
    expect(payload.by).toBe('PASSENGER');
    expect(payload.reason).toBe('bid_cancelled');
    expect(payload.penaltyCents).toBe(0);
  });

  it('transiciona REASSIGNING → CANCELLED_BY_PASSENGER (el pasajero se rinde durante el re-match)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REASSIGNING, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('no-op idempotente si el viaje ya está terminal (ya CANCELLED_BY_PASSENGER) — cancel repetido', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('no-op idempotente si la puja ya avanzó a match (ASSIGNED): no pisa el viaje', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('no-op si el viaje no existe (board evaporado de un trip inexistente)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.cancelFromBid('trip-x');
    expect(prisma._outbox).toHaveLength(0);
  });
});

describe('TripsService.cancel · PUJA · conductor cancela post-accept → REASSIGNING (ADR 010 #4)', () => {
  it('cancel del CONDUCTOR desde ACCEPTED → REASSIGNING + emite trip.reassigning ENRIQUECIDO (no termina)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-1',
        passengerId: 'pax-9',
        vehicleType: 'MOTO',
        originLat: -12.05,
        originLon: -77.04,
        fareCents: 900,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel(
      'trip-1',
      { by: 'DRIVER', reason: 'se me pinchó la llanta' },
      DRIVER_USER,
    );
    expect(view.status).toBe(TripStatus.REASSIGNING);
    const reassign = prisma._outbox.find((e) => e.eventType === 'trip.reassigning');
    expect(reassign).toBeTruthy();
    const payload = reassign?.envelope.payload as {
      tripId: string;
      driverId: string;
      passengerId: string;
      vehicleType: string;
      origin: { lat: number; lon: number };
      bidCents: number;
      reason: string;
    };
    expect(payload.bidCents).toBe(900); // re-abre al bid actual
    expect(payload.reason).toBe('driver_cancelled');
    // ENRIQUECIDO: dispatch reconstruye el board y libera al conductor que canceló sin la key vieja.
    expect(payload.driverId).toBe('drv-1'); // el que canceló (para liberarlo en dispatch)
    expect(payload.passengerId).toBe('pax-9');
    expect(payload.vehicleType).toBe('MOTO');
    expect(payload.origin).toEqual({ lat: -12.05, lon: -77.04 });
    // NO se emitió trip.cancelled (el viaje no terminó).
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(false);
    // El conductor que canceló se desvinculó (driverId → null) para el re-match.
    expect(prisma._store?.driverId).toBeNull();
    // reassignCount se incrementó (0 → 1).
    expect(prisma._store?.reassignCount).toBe(1);
  });

  it('reassignCount incrementa en cada cancelación (1 → 2)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVING, driverId: 'drv-2', reassignCount: 1 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(view.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._store?.reassignCount).toBe(2);
  });

  it('reassignCount > MAX (default 3) → FAILED terminal (NO REASSIGNING) + emite trip.failed (pasajero notificado)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-3',
        passengerId: 'pax-3',
        reassignCount: 3,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    // 4 > 3 → NO re-puja: cae a terminal honesto FAILED.
    expect(view.status).toBe(TripStatus.FAILED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
    const failed = prisma._outbox.find((e) => e.eventType === 'trip.failed');
    expect(failed).toBeTruthy();
    const payload = failed?.envelope.payload as {
      tripId: string;
      passengerId: string;
      fromStatus: string;
    };
    expect(payload.passengerId).toBe('pax-3'); // el pasajero recibe la notificación
    expect(payload.fromStatus).toBe(TripStatus.ACCEPTED);
    expect(prisma._store?.reassignCount).toBe(4);
  });

  it('cancel del CONDUCTOR desde ARRIVED → REASSIGNING', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ARRIVED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(view.status).toBe(TripStatus.REASSIGNING);
  });

  it('cancel del CONDUCTOR desde ASSIGNED (pre-accept) sigue siendo terminal CANCELLED_BY_DRIVER', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(view.status).toBe(TripStatus.CANCELLED_BY_DRIVER);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
  });

  // ADR 011 §1.2/§4 · la reasignación respeta el dispatchMode CONGELADO del viaje (no re-resuelve).
  it('FIXED · driver cancela post-accept → REASSIGNING + trip.requested + trip.reassigning (dispatchMode FIXED, libera al conductor)', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-1',
        dispatchMode: 'FIXED',
        fareCents: 1500,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(view.status).toBe(TripStatus.REASSIGNING);
    // FIXED re-despacha por trip.requested (matching secuencial) Y emite trip.reassigning con
    // dispatchMode FIXED — el evento transversal que LIBERA al conductor cancelador (identity
    // ON_TRIP→AVAILABLE + hot-index) SIN que dispatch re-abra un board de puja (lo gatea el modo).
    // Sin él (seam roto original) el conductor quedaba ON_TRIP para siempre tras cancelar un FIJO.
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    const reassigning = prisma._outbox.find((e) => e.eventType === 'trip.reassigning');
    expect(reassigning?.envelope.payload).toMatchObject({
      driverId: 'drv-1',
      dispatchMode: 'FIXED',
      reason: 'driver_cancelled',
    });
    // El conductor que canceló se desvincula para el re-match.
    expect(prisma._store?.driverId).toBeNull();
    // La tarifa fija NO cambia (BR-T01 inmutable).
    expect(prisma._store?.fareCents).toBe(1500);
    expect(prisma._store?.reassignCount).toBe(1);
    // ASIMETRÍA PUJA/FIXED: la reasignación FIXED NO toca los invariantes de negociación de la puja
    // (no hay re-negociación). Blindaje pre-L3 (Strategy): si el refactor tocara seq/agreedFare en FIXED,
    // esto lo caza. El fixture base trae negotiationSeq=1 y agreedFareCents=null.
    expect(prisma._store?.negotiationSeq).toBe(1); // H13: el seq de ciclo NO se bumpea en FIXED
    expect(prisma._store?.agreedFareCents).toBeNull(); // H12: el agreed-fare NO se toca en FIXED
  });

  it('PUJA · driver cancela post-accept → REASSIGNING + emite trip.reassigning (NO trip.requested)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1', dispatchMode: 'PUJA' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(view.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
  });
});

describe('TripsService.rebid · RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4)', () => {
  const PAX = 'pax-1';

  it('rebid desde REASSIGNING con un bid mayor → REQUESTED + fareCents actualizado + emite trip.bid_posted', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.REASSIGNING,
        passengerId: PAX,
        driverId: 'drv-old',
        fareCents: 900,
        reassignCount: 2,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.rebid('trip-1', PAX, 1500);
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(1500);
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
    expect(prisma._store?.fareCents).toBe(1500);
    // board fresco: emite trip.bid_posted con el NUEVO bid.
    const posted = prisma._outbox.find((e) => e.eventType === 'trip.bid_posted');
    expect(posted).toBeTruthy();
    expect((posted?.envelope.payload as { bidCents: number }).bidCents).toBe(1500);
    // registra el evento de dominio trip.rebid (auditoría del cambio de precio).
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.rebid')).toBe(true);
    // ciclo fresco: reassignCount reiniciado a 0 y el conductor viejo desvinculado.
    expect(prisma._store?.reassignCount).toBe(0);
    expect(prisma._store?.driverId).toBeNull();
  });

  it('rebid desde EXPIRED → REQUESTED (reactivado, ya no es callejón sin salida #12) + emite trip.bid_posted', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 800 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.rebid('trip-1', PAX, 1100);
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(1100);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('rebid permite CUALQUIER valor en [floor, techo] — no fuerza a subir (regla documentada)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 2000 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    // bid MENOR al anterior pero ≥ piso (700 default): se acepta.
    const view = await svc.rebid('trip-1', PAX, 750);
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(750);
  });

  it('rebid desde un estado inválido (IN_PROGRESS) → ConflictError (no emite eventos)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.IN_PROGRESS, passengerId: PAX, driverId: 'drv-1' }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
    expect(prisma._outbox).toHaveLength(0);
    expect(prisma._store?.status).toBe(TripStatus.IN_PROGRESS);
  });

  it('rebid desde un estado terminal (COMPLETED) → ConflictError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.COMPLETED, passengerId: PAX }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rebid por DEBAJO del piso → ValidationError (no emite eventos)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 100)).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('rebid por ENCIMA del techo (BID_MAX_CENTS) → ValidationError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 999_999_999)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rebid de un viaje AJENO → NotFoundError (no se filtra existencia ajena, ownership server-side)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: 'otro-pax' }));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('rebid de un viaje inexistente → NotFoundError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('doble-tap (carrera): el guard updateMany evita la doble apertura de board — el 2º rebid es no-op idempotente', async () => {
    // Modela DOS taps concurrentes que ambos LEYERON EXPIRED. El 1º gana el guard (status→REQUESTED).
    // El 2º entra a la tx con el where status=EXPIRED, pero el store YA es REQUESTED → count 0 → no re-emite.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 1500 }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);

    // 1er tap: gana, abre board fresco.
    const first = await svc.rebid('trip-1', PAX, 1500);
    expect(first.status).toBe(TripStatus.REQUESTED);
    const boardsAfterFirst = prisma._outbox.filter((e) => e.eventType === 'trip.bid_posted').length;
    expect(boardsAfterFirst).toBe(1);

    // 2º tap: el viaje ya es REQUESTED. El gate REBIDDABLE lo rechaza ANTES de abrir un 2º board.
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
    const boardsAfterSecond = prisma._outbox.filter(
      (e) => e.eventType === 'trip.bid_posted',
    ).length;
    expect(boardsAfterSecond).toBe(1); // NO se abrió un segundo board.
  });
});

describe('TripsService · H12 · re-negociación NO descarta la tarifa recién acordada (money-correctness)', () => {
  const PAX = 'pax-1';

  it('RE-MATCH tras driver-cancel: match@900 → cancel → REASSIGNING (agreedFareCents=null) → offer_accepted@1100 APLICA 1100', async () => {
    // El conductor aceptó a 900 y se aplicó el precio (agreedFareCents=900). Cancela → REASSIGNING.
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-1',
        passengerId: PAX,
        fareCents: 900,
        agreedFareCents: 900, // ya se acordó/aplicó el precio de la 1ª negociación
        reassignCount: 0,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);

    // Driver cancela post-accept → REASSIGNING. La re-negociación RESETEA el guard once-ever Y bumpea el ciclo.
    const view = await svc.cancel(
      'trip-1',
      { by: 'DRIVER', reason: 'se me pinchó la llanta' },
      DRIVER_USER,
    );
    expect(view.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._store?.agreedFareCents).toBeNull(); // H12: guard reseteado → próximo offer_accepted aplica
    // H13: el ciclo de negociación avanzó 1 → 2 (monotónico; NO resetea como reassignCount).
    expect(prisma._store?.negotiationSeq).toBe(2);

    // El re-match materializa ASSIGNED (dispatch.match_found: REASSIGNING → ASSIGNED) con otro conductor.
    // applyAgreedFare solo aplica en estados FARE_APPLICABLE (no en REASSIGNING) — espeja el orden real de eventos.
    await svc.assignFromDispatch('trip-1', 'drv-2');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._store?.agreedFareCents).toBeNull(); // el re-match NO re-marca el guard

    // H13 — THE MONEY TEST: una redelivery STALE del offer_accepted del CICLO 1 (seq=1 @ 900) llega DENTRO
    // de la ventana fare-applicable del ciclo 2 (agreedFareCents=null). El guard de ciclo lo descarta:
    // NO escribe la tarifa rancia de 900 del conductor del ciclo anterior.
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._store?.fareCents).toBe(900); // SIN cambios (el COUNTER del ciclo 2 aún no llegó; fare = bid actual)
    expect(prisma._store?.agreedFareCents).toBeNull(); // el stale NO marcó el guard
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(false);

    // El pasajero aceptó un COUNTER a 1100 en el board fresco del CICLO 2 → offer_accepted seq=2 @ 1100 APLICA.
    await svc.applyAgreedFare('trip-1', 1100, 2);
    // ANTES del fix H12: el guard agreedFareCents!==null bloqueaba esto. Ahora aplica el precio del ciclo correcto.
    expect(prisma._store?.fareCents).toBe(1100);
    expect(prisma._store?.agreedFareCents).toBe(1100);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });

  it('REBID + COUNTER: match@900 → cancel → REASSIGNING → rebid@1500 (agreedFareCents=null) → offer_accepted@1700 APLICA 1700', async () => {
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-1',
        passengerId: PAX,
        fareCents: 900,
        agreedFareCents: 900,
        reassignCount: 0,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);

    // 1) driver cancela → REASSIGNING (guard reseteado + ciclo 1 → 2 por la reasignación automática).
    await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
    expect(prisma._store?.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._store?.agreedFareCents).toBeNull();
    expect(prisma._store?.negotiationSeq).toBe(2);

    // 2) el pasajero SUBE explícitamente el bid a 1500 → REQUESTED, board fresco. El guard SIGUE null Y el
    //    ciclo avanza otra vez 2 → 3 (rebid es monotónico igual que la reasignación; reassignCount SÍ resetea).
    const rebidView = await svc.rebid('trip-1', PAX, 1500);
    expect(rebidView.status).toBe(TripStatus.REQUESTED);
    expect(prisma._store?.fareCents).toBe(1500);
    expect(prisma._store?.agreedFareCents).toBeNull(); // H12: rebid también resetea el guard
    expect(prisma._store?.negotiationSeq).toBe(3);
    expect(prisma._store?.reassignCount).toBe(0); // contraste: reassignCount SÍ resetea, negotiationSeq NO

    // 3) H13 — un offer_accepted STALE de un ciclo anterior (seq=1 o seq=2) llega tarde → RECHAZADO (no-op).
    await svc.applyAgreedFare('trip-1', 900, 1);
    await svc.applyAgreedFare('trip-1', 1100, 2);
    expect(prisma._store?.fareCents).toBe(1500); // intacto: ningún ciclo viejo escribió
    expect(prisma._store?.agreedFareCents).toBeNull();
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(false);

    // 4) un conductor contra-ofertó y el pasajero aceptó a 1700 en el ciclo 3 → seq=3 APLICA (no bloqueado).
    await svc.applyAgreedFare('trip-1', 1700, 3);
    expect(prisma._store?.fareCents).toBe(1700);
    expect(prisma._store?.agreedFareCents).toBe(1700);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });

  it('REGRESIÓN N7: DENTRO de UNA negociación, una redelivery duplicada del MISMO offer_accepted@900 sigue siendo NO-OP', async () => {
    // El fix NO debe debilitar el guard intra-negociación: una vez aplicado 900, reentregar el MISMO
    // evento NO re-aplica (sin reasignación/rebid de por medio, el guard once-ever sigue intacto).
    const prisma = makePrisma(
      buildTrip({
        status: TripStatus.ACCEPTED,
        driverId: 'drv-1',
        fareCents: 900,
        agreedFareCents: null,
      }),
    );
    const svc = new TripsService(new TripsRepository(prisma as never), maps);

    await svc.applyAgreedFare('trip-1', 900, 1); // 1ª aplicación: marca agreedFareCents=900
    expect(prisma._store?.agreedFareCents).toBe(900);
    const eventsAfterFirst = prisma._tripEvents.filter(
      (e) => e.eventType === 'trip.fare_agreed',
    ).length;
    expect(eventsAfterFirst).toBe(1);

    await svc.applyAgreedFare('trip-1', 900, 1); // redelivery del MISMO evento: NO-OP
    expect(prisma._store?.agreedFareCents).toBe(900); // sin cambios
    const eventsAfterSecond = prisma._tripEvents.filter(
      (e) => e.eventType === 'trip.fare_agreed',
    ).length;
    expect(eventsAfterSecond).toBe(1); // NO hubo doble-apply
  });
});

describe('TripsService.complete · EFECTIVO (cashCollected propaga al evento)', () => {
  function inProgressCash(method: PaymentMethod = PaymentMethod.CASH) {
    return buildTrip({
      status: TripStatus.IN_PROGRESS,
      driverId: 'drv-1',
      paymentMethod: method,
    });
  }

  function completedPayload(prisma: ReturnType<typeof makePrisma>) {
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.completed');
    return ev?.envelope.payload as { paymentMethod?: string; cashCollected?: boolean } | undefined;
  }

  it('viaje CASH + cashCollected=true → el flag viaja en trip.completed (driver cobró en mano)', async () => {
    const prisma = makePrisma(inProgressCash());
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.complete('trip-1', { cashCollected: true });
    expect(view.status).toBe(TripStatus.COMPLETED);
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('CASH');
    expect(payload?.cashCollected).toBe(true);
  });

  it('viaje CASH sin cashCollected → cashCollected ausente (undefined): flujo bilateral normal', async () => {
    const prisma = makePrisma(inProgressCash());
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.complete('trip-1'); // sin dto (default {})
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('CASH');
    expect(payload?.cashCollected).toBeUndefined();
  });

  it('viaje DIGITAL (YAPE) ignora el flag: cashCollected NO viaja aunque se mande true', async () => {
    const prisma = makePrisma(inProgressCash(PaymentMethod.YAPE));
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.complete('trip-1', { cashCollected: true });
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('YAPE');
    expect(payload?.cashCollected).toBeUndefined(); // digital: el flag es ruido, no se propaga
  });

  it('anti-IDOR: un driverId que no es el del viaje → 404 (NotFoundError), no completa', async () => {
    const prisma = makePrisma(inProgressCash());
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.complete('trip-1', { driverId: 'drv-OTRO', cashCollected: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._store?.status).toBe(TripStatus.IN_PROGRESS); // sin transición
  });
});

describe('TripsService.complete · MÉTRICAS (origen viaja en trip.completed → corte "Ingresos por distrito")', () => {
  function inProgress() {
    return buildTrip({ status: TripStatus.IN_PROGRESS, driverId: 'drv-1' });
  }

  /** Extrae el origen del payload trip.completed encolado (lat = originLat, lon = originLng en el evento). */
  function completedGeo(prisma: ReturnType<typeof makePrisma>) {
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.completed');
    return ev?.envelope.payload as { originLat?: number; originLng?: number } | undefined;
  }

  it('el ORIGEN del viaje (originLat + originLon→originLng) viaja en trip.completed → payment lo zonifica a distrito', async () => {
    const prisma = makePrisma(inProgress());
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await svc.complete('trip-1');
    const payload = completedGeo(prisma);
    // el trip persiste el origen como originLat/originLon; el evento expone la lat como originLat y la lon
    // como originLng (buildTrip default: -12.0464 / -77.0428). SIN esto el corte por distrito queda vacío.
    expect(payload?.originLat).toBe(-12.0464);
    expect(payload?.originLng).toBe(-77.0428);
  });
});

// ──────────────────────── ADR 013 · catálogo de ofertas en createTrip (Lote B) ────────────────────────

describe('TripsService.createTrip · ADR 013 · oferta del catálogo (precedencia + pool + pricing)', () => {
  it('(a) category DESCONOCIDA → 400 UNKNOWN_OFFERING tipado; NO se crea nada (jamás default económico)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(
      svc.createTrip({ ...baseCreateDto, category: 'veo_fantasma' }),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_OFFERING',
      httpStatus: 400,
    });
    expect(prisma._outbox).toHaveLength(0);
    expect(prisma._store).toBeNull();
  });

  it('(b) category AUSENTE + vehicleType MOTO (cliente viejo) → resuelve veo_moto y SU pricing (825)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps); // sin resolver, sin bid ⇒ FIXED legacy
    const view = await svc.createTrip({ ...baseCreateDto, vehicleType: 'MOTO' });
    // Pool del catálogo (no del dto suelto, aunque acá coinciden) + política REAL de moto:
    // base 1500 (5000m/600s) × 0.55 = 825 ≥ minFare 300. ANTES del fix cobraba 1500 (más que el quote).
    expect(prisma._store?.vehicleType).toBe('MOTO');
    expect(view.fareCents).toBe(825);
    expect(prisma._store?.category).toBeNull(); // el cliente viejo no mandó category: se persiste null
  });

  it('(c) INCONSISTENCIA category veo_moto + vehicleType CAR → gana la OFERTA (pool MOTO) + warn', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const warnSpy = vi.spyOn(svc['logger'], 'warn');
    const view = await svc.createTrip({
      ...baseCreateDto,
      category: OfferingId.VEO_MOTO,
      vehicleType: 'CAR',
    });
    // offering.vehicleClass es la fuente del pool: el viaje va al pool MOTO con el pricing de moto.
    expect(prisma._store?.vehicleType).toBe('MOTO');
    expect(view.fareCents).toBe(825);
    const requested = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    expect((requested?.envelope.payload as { vehicleType?: string }).vehicleType).toBe('MOTO');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('inconsistentes'));
  });

  it('(e) FIXED + veo_confort: la tarifa FIRME es ×1.25 → 1875 (= round(1500 × 1.25), mínima 500 no muerde)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto, category: OfferingId.VEO_CONFORT });
    expect(view.fareCents).toBe(1875); // ANTES del fix: 1500 (cobraba la tarifa de económico)
    expect(prisma._store?.dispatchMode).toBe('FIXED');
    expect(prisma._store?.category).toBe(OfferingId.VEO_CONFORT);
  });

  it('(e) FIXED + veo_moto: ×0.55 con minFare 300 → 825 (moto DEJA de cobrar de más que su preview)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto, category: OfferingId.VEO_MOTO });
    expect(view.fareCents).toBe(825); // max(round(1500 × 0.55), 300) — ANTES del fix: 1500
    expect(view.fareCents).toBeLessThan(1500);
    expect(prisma._store?.vehicleType).toBe('MOTO');
  });

  it('(e) FIXED + veo_economico: ×1.0 → 1500 INVARIANTE (golden-path/pricing-switch no cambian de montos)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    const view = await svc.createTrip({ ...baseCreateDto, category: OfferingId.VEO_ECONOMICO });
    expect(view.fareCents).toBe(1500); // max(round(1500 × 1.0), 500) = 1500: cero regresión
  });

  it('PUJA + category premium: el bid sigue siendo la tarifa (la política NO toca el bid)', async () => {
    const prisma = makePrisma(null);
    // ADR 023: la oferta confort está pineada a PUJA (palanca del admin) → el bid ES la tarifa.
    const svc = new TripsService(
      new TripsRepository(prisma as never),
      maps,
      undefined,
      undefined,
      undefined,
      fakeCatalog({ mode: PricingMode.PUJA }),
    );
    const view = await svc.createTrip({
      ...baseCreateDto,
      category: OfferingId.VEO_CONFORT,
      bidCents: 900,
    });
    expect(view.fareCents).toBe(900); // el bid ES la tarifa; el multiplier solo afecta el quote
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });
});

// ─────────── mini-lote "abrir el wire" · CONTRATO producer↔schema POR CLASE de vehículo ───────────

describe('CONTRATO producer↔schema · parametrizado POR CLASE (gap 3 de la prueba de fuego ADR 013)', () => {
  /**
   * El gate del consumer (@veo/events KafkaEventConsumer: safeParse → DESCARTA) es donde un evento con
   * una clase nueva moría EN SILENCIO (prueba de fuego VEO_AMBULANCIA). Estas filas iteran el enum
   * canónico `VehicleClass`: una clase NUEVA queda cubierta SOLA, y si alguien re-hardcodea el
   * z.enum(['CAR','MOTO']) en @veo/events en vez de derivarlo del enum, GRITA acá — no en producción.
   * El payload es el REAL del producer (trip-events.ts / PujaDispatchStrategy.reassign), no un fixture.
   */
  const vehicleClasses = Object.values(VehicleClass);
  const origin = { lat: -12.0464, lon: -77.0428 };
  const destination = { lat: -12.1219, lon: -77.0297 };

  it.each(vehicleClasses)(
    'trip.requested · el payload REAL de emitTripRequested con clase %s pasa el schema registrado',
    async (vehicleClass) => {
      const prisma = makePrisma(null);
      await prisma.write.$transaction(async (tx) => {
        await emitTripRequested(
          tx as never,
          buildTrip({ vehicleType: vehicleClass }),
          origin,
          destination,
        );
      });
      const event = prisma._outbox.find((e) => e.eventType === 'trip.requested');
      expect(event).toBeTruthy();
      expect(EVENT_SCHEMAS['trip.requested'].safeParse(event!.envelope.payload).success).toBe(true);
      // La clase viaja TAL CUAL (sin casteo silencioso a otra clase): el pool de matching es fiel.
      expect((event!.envelope.payload as { vehicleType?: string }).vehicleType).toBe(vehicleClass);
    },
  );

  it('trip.requested · B5-3: la `category` (oferta) viaja en el payload del outbox (dispatch filtra eligibilidad)', async () => {
    const prisma = makePrisma(null);
    await prisma.write.$transaction(async (tx) => {
      await emitTripRequested(
        tx as never,
        buildTrip({ category: 'veo_confort' }),
        origin,
        destination,
      );
    });
    const event = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    // Sin esto el wire de eligibilidad queda mudo (dispatch nunca resuelve los requisitos de la oferta).
    expect((event!.envelope.payload as { category?: string }).category).toBe('veo_confort');
    expect(EVENT_SCHEMAS['trip.requested'].safeParse(event!.envelope.payload).success).toBe(true);
  });

  it.each(vehicleClasses)(
    'trip.bid_posted · el payload REAL de emitBidPosted con clase %s pasa el schema registrado',
    async (vehicleClass) => {
      const prisma = makePrisma(null);
      await prisma.write.$transaction(async (tx) => {
        await emitBidPosted(tx as never, buildTrip({ vehicleType: vehicleClass }), origin, 60);
      });
      const event = prisma._outbox.find((e) => e.eventType === 'trip.bid_posted');
      expect(event).toBeTruthy();
      expect(EVENT_SCHEMAS['trip.bid_posted'].safeParse(event!.envelope.payload).success).toBe(
        true,
      );
      expect((event!.envelope.payload as { vehicleType?: string }).vehicleType).toBe(vehicleClass);
    },
  );

  it.each(vehicleClasses)(
    'trip.reassigning · cancel(DRIVER) post-accept con clase %s emite un payload que pasa el schema registrado',
    async (vehicleClass) => {
      const prisma = makePrisma(
        buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1', vehicleType: vehicleClass }),
      );
      const svc = new TripsService(new TripsRepository(prisma as never), maps);
      await svc.cancel('trip-1', { by: 'DRIVER' }, DRIVER_USER);
      const event = prisma._outbox.find((e) => e.eventType === 'trip.reassigning');
      expect(event).toBeTruthy();
      expect(EVENT_SCHEMAS['trip.reassigning'].safeParse(event!.envelope.payload).success).toBe(
        true,
      );
      expect((event!.envelope.payload as { vehicleType?: string }).vehicleType).toBe(vehicleClass);
    },
  );
});

describe('TripsService.reassignForDriverOffline · Fase B (ADR-021 B1)', () => {
  /** Prisma mínimo que expone read.trip.findFirst (capturando el where) + los stubs que toca la reasignación. */
  function makeOfflinePrisma(found: Trip | null) {
    const calls: { where?: unknown }[] = [];
    const outbox: { eventType: string }[] = [];
    const tx = {
      trip: {
        update: async ({ data }: { data: Record<string, unknown> }) => ({
          ...(found as Trip),
          ...data,
        }),
        findUniqueOrThrow: async () => found,
      },
      tripEvent: { create: async () => ({}) },
      outboxEvent: {
        create: async ({ data }: { data: { eventType: string } }) => {
          outbox.push({ eventType: data.eventType });
          return {};
        },
      },
    };
    const prisma = {
      read: {
        trip: {
          findFirst: async (args: { where?: unknown }) => {
            calls.push({ where: args?.where });
            return found;
          },
        },
      },
      write: {
        $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
      _calls: calls,
      _outbox: outbox,
    };
    return prisma;
  }

  it('sin viaje pre-recojo del conductor (findFirst null) → NO-OP, no emite trip.reassigning', async () => {
    const prisma = makeOfflinePrisma(null);
    const svc = new TripsService(new TripsRepository(prisma as never), maps);
    await expect(svc.reassignForDriverOffline('drv-9')).resolves.toBeUndefined();
    // Consulta por driverId + estados POST-accept (ACCEPTED/ARRIVING/ARRIVED).
    const where = prisma._calls[0]?.where as { driverId?: string; status?: { in?: string[] } };
    expect(where.driverId).toBe('drv-9');
    expect(where.status?.in).toEqual(
      expect.arrayContaining([TripStatus.ACCEPTED, TripStatus.ARRIVING, TripStatus.ARRIVED]),
    );
    expect(where.status?.in).not.toContain(TripStatus.ASSIGNED); // ASSIGNED es Fase G, fuera de scope
    expect(prisma._outbox).toHaveLength(0);
  });
});
