import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from '@veo/utils';
import { TripStatus, PaymentMethod } from '@veo/shared-types';
import { TripsService } from './trips.service';
import { InvalidTripTransition } from './domain/trip-state-machine';
import { Prisma, type Trip } from '../generated/prisma';

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
function makePrisma(initial: Trip | null) {
  let store = initial;
  const outbox: PublishedEvent[] = [];
  const tripEvents: { eventType: string; payload: unknown }[] = [];

  const tx = {
    trip: {
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
        };
        data: Partial<Trip>;
      }) => {
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

/**
 * ADR 011 · doble del ModeResolver (PricingScheduleService) que FUERZA un modo fijo, para testear la
 * resolución server-side de createTrip independientemente de la presencia de bidCents del cliente.
 */
function fakeResolver(mode: 'PUJA' | 'FIXED') {
  return { resolve: async () => mode } as never;
}

describe('TripsService.createTrip · BR-T05 + outbox', () => {
  it('crea en REQUESTED, calcula tarifa real y encola trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
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
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.createTrip({ ...baseCreateDto }, 'key-123');
    expect(view.fareCents).toBe(999);
    // No se encoló ningún evento nuevo (devolvió el existente).
    expect(prisma._outbox).toHaveLength(0);
  });

  it('modo niño sin código → ValidationError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    await expect(
      svc.createTrip({ ...baseCreateDto, childMode: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('Ola 2B · scheduledFor futuro → SCHEDULED, registra trip.scheduled y NO emite trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const view = await svc.createTrip({ ...baseCreateDto, scheduledFor });
    expect(view.status).toBe(TripStatus.SCHEDULED);
    expect(view.scheduledFor).toBeTruthy();
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.scheduled')).toBe(true);
  });

  it('Ola 2B · scheduledFor demasiado pronto (<15min) → ValidationError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // +5min
    await expect(svc.createTrip({ ...baseCreateDto, scheduledFor: soon })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('Ola 2B · MOTO se propaga al evento trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    await svc.createTrip({ ...baseCreateDto, vehicleType: 'MOTO' });
    const requested = prisma._outbox.find((e) => e.eventType === 'trip.requested');
    expect((requested?.envelope.payload as { vehicleType?: string }).vehicleType).toBe('MOTO');
  });
});

describe('TripsService · Ola 2B viajes programados (activación / cancelación)', () => {
  it('activateScheduledTrip · FIXED transiciona SCHEDULED → REQUESTED y emite trip.requested (ADR 011)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'FIXED' }),
    );
    const svc = new TripsService(prisma as never, maps);
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
  });

  it('activateScheduledTrip · PUJA respeta el dispatchMode congelado → emite trip.bid_posted (ADR 011 §1.2)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), dispatchMode: 'PUJA' }),
    );
    const svc = new TripsService(prisma as never, maps);
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._store?.status).toBe(TripStatus.REQUESTED);
  });

  it('activateScheduledTrip es idempotente si ya no está SCHEDULED', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(prisma as never, maps);
    await svc.activateScheduledTrip('trip-1');
    expect(prisma._outbox).toHaveLength(0);
  });

  it('cancelScheduledTrip sin penalidad (→ CANCELLED_BY_PASSENGER, penaltyCents 0)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.SCHEDULED, scheduledFor: new Date(), passengerId: 'pax-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancelScheduledTrip('trip-1', 'pax-1');
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(view.penaltyCents).toBe(0);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('cancelScheduledTrip sobre un viaje ya activado → ConflictError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED, passengerId: 'pax-1' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.cancelScheduledTrip('trip-1', 'pax-1')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('TripsService · BR-T02 guardas de transición', () => {
  it('assign sobre un viaje COMPLETED lanza InvalidTripTransition', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.COMPLETED }));
    const svc = new TripsService(prisma as never, maps);
    await expect(
      svc.assignDriver('trip-1', {
        driverId: '22222222-2222-2222-2222-222222222222',
        vehicleId: '33333333-3333-3333-3333-333333333333',
      }),
    ).rejects.toBeInstanceOf(InvalidTripTransition);
  });

  it('assign en REQUESTED → ASSIGNED y emite trip.assigned', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.assignDriver('trip-1', {
      driverId: '22222222-2222-2222-2222-222222222222',
      vehicleId: '33333333-3333-3333-3333-333333333333',
    });
    expect(view.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.assigned')).toBe(true);
  });

  it('assignFromDispatch es idempotente si ya está ASSIGNED con el mismo conductor', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-9' }),
    );
    const svc = new TripsService(prisma as never, maps);
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
      const svc = new TripsService(prisma as never, maps);
      // La prueba del no-poison: NO debe lanzar (resolves), de lo contrario kafkajs reintentaría infinito.
      await expect(svc.assignFromDispatch('trip-1', 'drv-9')).resolves.toBeUndefined();
      expect(prisma._store?.status).toBe(status); // el viaje muerto NO cambió de estado
      expect(prisma._outbox).toHaveLength(0); // NO se emitió trip.assigned
    }
  });

  it('N10: assignFromDispatch sobre un viaje ACTIVO (REQUESTED) → SÍ asigna — contraste', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(prisma as never, maps);
    await svc.assignFromDispatch('trip-1', 'drv-9');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._store?.driverId).toBe('drv-9');
    expect(prisma._outbox.some((e) => e.eventType === 'trip.assigned')).toBe(true);
  });

  it('getTrip inexistente → NotFoundError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.getTrip('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('TripsService.start · BR-T07 modo niño', () => {
  it('código correcto inicia el viaje (→ IN_PROGRESS) y emite trip.started', async () => {
    const hash = bcrypt.hashSync('1234', 10);
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: hash, driverId: 'drv-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.start('trip-1', { childCode: '1234' });
    expect(view.status).toBe(TripStatus.IN_PROGRESS);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.started')).toBe(true);
  });

  it('código incorrecto NO avanza, emite alerta trip.child_code_failed y lanza ValidationError', async () => {
    const hash = bcrypt.hashSync('1234', 10);
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: hash, driverId: 'drv-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.start('trip-1', { childCode: '9999' })).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.child_code_failed')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.started')).toBe(false);
    // el estado no avanzó
    expect(prisma._store?.status).toBe(TripStatus.ARRIVED);
  });

  it('viaje con modo niño sin código → ValidationError', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: bcrypt.hashSync('1234', 10), driverId: 'd' }),
    );
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.start('trip-1', {})).rejects.toBeInstanceOf(ValidationError);
  });

  // A1 · anti-IDOR (ownership server-side; el driver-bff deriva el driverId y lo manda)
  it('start con driverId AJENO → 404 (no inicia ni prueba el código del viaje de otro conductor)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: bcrypt.hashSync('1234', 10), driverId: 'drv-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.start('trip-1', { childCode: '1234', driverId: 'drv-OTRO' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // No avanzó ni emitió nada (ni siquiera el child_code_failed): el viaje ajeno es "inexistente".
    expect(prisma._store?.status).toBe(TripStatus.ARRIVED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('start con el driverId PROPIO → inicia ok (contraste anti-IDOR)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: bcrypt.hashSync('1234', 10), driverId: 'drv-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' });
    expect(view.status).toBe(TripStatus.IN_PROGRESS);
  });
});

describe('TripsService.start · B · lockout anti-brute-force del código de modo niño (Redis)', () => {
  function build(redis: ReturnType<typeof makeRedis>) {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ARRIVED, childMode: true, childCodeHash: bcrypt.hashSync('1234', 10), driverId: 'drv-1' }),
    );
    // constructor: (prisma, maps, config?, modeResolver?, redis?) — redis va 5º.
    const svc = new TripsService(prisma as never, maps, undefined, undefined, redis as never);
    return { prisma, svc };
  }

  it('5 intentos fallidos → el 6º queda BLOQUEADO con 429 (RateLimitError)', async () => {
    const redis = makeRedis();
    const { svc } = build(redis);
    // 5 intentos con código incorrecto: cada uno lanza ValidationError (no bloqueo todavía).
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.start('trip-1', { childCode: '9999', driverId: 'drv-1' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // tras 5 fallos el candado está echado: el 6º intento (aunque mande el código CORRECTO) → 429.
    await expect(svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(redis._store.get('childcode:lock:trip-1')).toBe('1');
  });

  it('un acierto ANTES del tope resetea el contador y el candado (DEL)', async () => {
    const redis = makeRedis();
    const { svc } = build(redis);
    // 3 fallos (contador en 3, sin candado aún).
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.start('trip-1', { childCode: '9999', driverId: 'drv-1' })).rejects.toBeInstanceOf(
        ValidationError,
      );
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
    await expect(svc.start('trip-1', { childCode: '1234', driverId: 'drv-1' })).rejects.toBeInstanceOf(
      RateLimitError,
    );
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
    const svc = new TripsService(prisma as never, longRoute);
    const view = await svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } });
    // 600 + 120*10 + 30*20 = 600 + 1200 + 600 = 2400
    expect(view.fareCents).toBe(2400);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.destination_changed')).toBe(true);
  });

  it('no permite cambiar destino una vez IN_PROGRESS (tarifa inmutable)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.IN_PROGRESS }));
    const svc = new TripsService(prisma as never, maps);
    await expect(
      svc.changeDestination('trip-1', { destination: { lat: -12.2, lon: -77.0 } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('TripsService.cancel · BR-T03', () => {
  it('cancelación del pasajero tras la gracia con conductor puntual → penaliza S/3', async () => {
    const assignedAt = new Date(Date.now() - 5 * 60_000); // 5 min atrás
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, assignedAt, driverId: 'drv-1', durationSeconds: 3600 }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'PASSENGER', reason: 'cambié de planes' });
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(view.penaltyCents).toBe(300);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('cancelación del pasajero dentro de la gracia (< 2 min) → sin penalización', async () => {
    const assignedAt = new Date(Date.now() - 30_000); // 30s atrás
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, assignedAt, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'PASSENGER' });
    expect(view.penaltyCents).toBe(0);
  });

  // A1 · anti-IDOR (ownership server-side, defensa en profundidad)
  it('PASSENGER con passengerId AJENO → 404 (no cancela el viaje de otro)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, passengerId: 'pax-1', driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(
      svc.cancel('trip-1', { by: 'PASSENGER', passengerId: 'pax-OTRO' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(false);
  });

  it('PASSENGER con su PROPIO passengerId → cancela ok', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, passengerId: 'pax-1', driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'PASSENGER', passengerId: 'pax-1' });
    expect(view.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
  });
});

// ──────────────────────────── PUJA (ADR 010 · Lote C) ────────────────────────────

describe('TripsService.createTrip · PUJA · el bid es el fareCents (ADR 010 §2)', () => {
  it('rechaza un bid por debajo del piso global (ValidationError)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    // piso default S/7 = 700; bid 500 < 700 → rechazo
    await expect(
      svc.createTrip({ ...baseCreateDto, bidCents: 500 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('acepta un bid válido (≥ piso): fareCents = bid y emite trip.bid_posted (NO trip.requested)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
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
    // ADR 011 M1: con bid ⇒ dispatchMode PUJA persistido en la fila.
    expect(prisma._store?.dispatchMode).toBe('PUJA');
  });

  it('bid exactamente en el piso (700) es válido', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 700 });
    expect(view.fareCents).toBe(700);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('rechaza un bid por encima del techo (ValidationError, gate AUTORITATIVO anti-overflow int4)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    // techo default BID_MAX_CENTS = 999_900; un bid desbocado overflowearía el int4 de fareCents.
    await expect(
      svc.createTrip({ ...baseCreateDto, bidCents: 9_999_999_999 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('bid exactamente en el techo (999_900) es válido', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 999_900 });
    expect(view.fareCents).toBe(999_900);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('sin bid → flujo legacy (tarifa por ruta) emite trip.requested', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.fareCents).toBe(1500);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
  });
});

// ──────────────────────── ADR 011 · createTrip server-resolved (ModeResolver) ────────────────────────

describe('TripsService.createTrip · ADR 011 · el SERVIDOR resuelve el modo (no el cliente)', () => {
  it('mode=PUJA REQUIERE bidCents: si falta → 400 "falta tu oferta"', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, fakeResolver('PUJA'));
    // El resolver fuerza PUJA pero el cliente NO mandó bid → ValidationError (HTTP 400).
    await expect(svc.createTrip({ ...baseCreateDto })).rejects.toMatchObject({
      httpStatus: 400,
      message: 'falta tu oferta',
    });
    expect(prisma._outbox).toHaveLength(0); // no se creó nada
  });

  it('mode=PUJA con bidCents → emite trip.bid_posted y persiste dispatchMode PUJA', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, fakeResolver('PUJA'));
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.fareCents).toBe(900);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
    expect(prisma._store?.dispatchMode).toBe('PUJA');
  });

  it('mode=FIXED IGNORA bidCents, usa calculateFare y emite trip.requested (dispatchMode FIXED)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, fakeResolver('FIXED'));
    // El cliente manda un bid, pero el SERVIDOR resolvió FIXED → se IGNORA el bid; tarifa por ruta (1500).
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.fareCents).toBe(1500); // calculateFare, NO el bid de 900
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(false);
    expect(prisma._store?.dispatchMode).toBe('FIXED');
  });

  // S1 (M5) — el modo CONGELADO viaja en la TripView (createTrip + getTrip) para que la app reconcilie.
  it('S1: la vista de createTrip expone dispatchMode = PUJA (server-resolved)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, fakeResolver('PUJA'));
    const view = await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(view.dispatchMode).toBe('PUJA');
  });

  it('S1: la vista de createTrip expone dispatchMode = FIXED (server-resolved)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, fakeResolver('FIXED'));
    const view = await svc.createTrip({ ...baseCreateDto });
    expect(view.dispatchMode).toBe('FIXED');
  });

  it('S1: getTrip también expone el dispatchMode congelado del viaje', async () => {
    const prisma = makePrisma(buildTrip({ dispatchMode: 'FIXED' }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.getTrip('trip-1');
    expect(view.dispatchMode).toBe('FIXED');
  });
});

describe('TripsService.createTrip · ADR 011 · S2 · resuelve para la hora de RECOJO (lock-at-booking)', () => {
  /**
   * S2 — doble del ModeResolver que CAPTURA el instante `at` con el que createTrip lo invoca, y que puede
   * devolver modos distintos según la hora (now vs pickup) para probar que se usa la hora de RECOJO.
   */
  function capturingResolver(modeByAt: (at: Date) => 'PUJA' | 'FIXED') {
    const calls: Date[] = [];
    const resolver = {
      resolve: async (_zone: 'GLOBAL', at: Date) => {
        calls.push(at);
        return modeByAt(at);
      },
    } as never;
    return { resolver, calls };
  }

  it('un viaje programado resuelve con scheduledFor (pickup), NO con now', async () => {
    // Schedule simulado: a las 14:00 (now) sería PUJA, pero a las 22:00 (recojo) es FIXED. El viaje debe
    // congelarse FIXED (la política de la HORA de recojo, lo que el pasajero vio en el quote).
    const PICKUP = new Date(Date.now() + 6 * 60 * 60 * 1000); // +6h, dentro de la ventana de reserva
    const { resolver, calls } = capturingResolver((at) =>
      at.getTime() >= PICKUP.getTime() - 60_000 ? 'FIXED' : 'PUJA',
    );
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, resolver);

    const view = await svc.createTrip({ ...baseCreateDto, scheduledFor: PICKUP.toISOString() });

    // Se resolvió con la hora de RECOJO (no now): el resolver recibió ~PICKUP.
    expect(calls).toHaveLength(1);
    expect(Math.abs(calls[0]!.getTime() - PICKUP.getTime())).toBeLessThan(2000);
    // Y el modo congelado refleja la política del recojo (FIXED), no la de now (PUJA).
    expect(view.dispatchMode).toBe('FIXED');
    expect(prisma._store?.dispatchMode).toBe('FIXED');
    expect(view.status).toBe(TripStatus.SCHEDULED);
  });

  it('un viaje INMEDIATO (sin scheduledFor) resuelve con now (sin cambio de comportamiento)', async () => {
    const { resolver, calls } = capturingResolver(() => 'PUJA');
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps, undefined, resolver);
    const before = Date.now();
    await svc.createTrip({ ...baseCreateDto, bidCents: 900 });
    expect(calls).toHaveLength(1);
    // Sin reserva → at ≈ now.
    expect(calls[0]!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(calls[0]!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('TripsService.applyAgreedFare · dispatch.offer_accepted (ADR 010 §4)', () => {
  it('fija fareCents = priceCents acordado (puede diferir del bid si fue COUNTER) y marca agreedFareCents', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
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
    const svc = new TripsService(prisma as never, maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._tripEvents).toHaveLength(0);
    expect(prisma._store?.fareCents).toBe(900);
  });

  it('N7: una redelivery del offer_accepted VIEJO tras un changeDestination NO revierte la tarifa', async () => {
    // Escenario del lost-update: el pasajero aceptó un COUNTER (fare=900, agreedFareCents=900) y LUEGO
    // un changeDestination recalculó la tarifa a 1200 (agreedFareCents intacto). Una redelivery
    // at-least-once del offer_accepted VIEJO (900) NO debe sobreescribir 1200 de vuelta a 900.
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ASSIGNED, fareCents: 1200, agreedFareCents: 900, driverId: 'drv-1' }),
    );
    const svc = new TripsService(prisma as never, maps);
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
    const svc = new TripsService(prisma as never, maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._store?.agreedFareCents).toBe(900);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });

  it('rechaza un precio acordado por encima del techo (defensa en profundidad, no escribe fareCents)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, fareCents: 900, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.applyAgreedFare('trip-1', 9_999_999_999, 1)).rejects.toBeInstanceOf(ValidationError);
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
      const svc = new TripsService(prisma as never, maps);
      await svc.applyAgreedFare('trip-1', 900, 1);
      expect(prisma._store?.fareCents).toBe(1500); // NO se escribió la tarifa acordada
      expect(prisma._store?.agreedFareCents).toBeNull(); // NO se marcó el agreed-fare
      expect(prisma._tripEvents).toHaveLength(0); // NO se emitió trip.fare_agreed
    }
  });

  it('N9: SÍ aplica sobre un viaje ACTIVO (no terminal) — contraste del status-guard', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ACCEPTED, fareCents: 1500, agreedFareCents: null }));
    const svc = new TripsService(prisma as never, maps);
    await svc.applyAgreedFare('trip-1', 900, 1);
    expect(prisma._store?.fareCents).toBe(900);
    expect(prisma._store?.agreedFareCents).toBe(900);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.fare_agreed')).toBe(true);
  });
});

describe('TripsService.expireFromNoOffers · dispatch.no_offers → EXPIRED (ADR 010 §4/§5)', () => {
  it('transiciona REQUESTED → EXPIRED y emite trip.expired', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(prisma as never, maps);
    await svc.expireFromNoOffers('trip-1', 'window_expired');
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
  });

  it('transiciona REASSIGNING → EXPIRED (re-puja sin ofertas)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REASSIGNING }));
    const svc = new TripsService(prisma as never, maps);
    await svc.expireFromNoOffers('trip-1', 'all_lapsed');
    expect(prisma._store?.status).toBe(TripStatus.EXPIRED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(true);
  });

  it('no-op idempotente si la puja ya cerró (p.ej. ya ASSIGNED)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await svc.expireFromNoOffers('trip-1', 'window_expired');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox).toHaveLength(0);
  });
});

describe('TripsService.cancelFromBid · dispatch.bid_cancelled → CANCELLED_BY_PASSENGER (FIX cancel-puja)', () => {
  it('transiciona REQUESTED → CANCELLED_BY_PASSENGER + emite trip.cancelled (by PASSENGER, sin penalidad)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REQUESTED }));
    const svc = new TripsService(prisma as never, maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._store?.penaltyCents).toBe(0);
    const cancelled = prisma._outbox.find((e) => e.eventType === 'trip.cancelled');
    expect(cancelled).toBeTruthy();
    const payload = cancelled?.envelope.payload as { by: string; reason: string; penaltyCents: number };
    expect(payload.by).toBe('PASSENGER');
    expect(payload.reason).toBe('bid_cancelled');
    expect(payload.penaltyCents).toBe(0);
  });

  it('transiciona REASSIGNING → CANCELLED_BY_PASSENGER (el pasajero se rinde durante el re-match)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.REASSIGNING, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
  });

  it('no-op idempotente si el viaje ya está terminal (ya CANCELLED_BY_PASSENGER) — cancel repetido', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.CANCELLED_BY_PASSENGER }));
    const svc = new TripsService(prisma as never, maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.CANCELLED_BY_PASSENGER);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('no-op idempotente si la puja ya avanzó a match (ASSIGNED): no pisa el viaje', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await svc.cancelFromBid('trip-1');
    expect(prisma._store?.status).toBe(TripStatus.ASSIGNED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('no-op si el viaje no existe (board evaporado de un trip inexistente)', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
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
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER', reason: 'se me pinchó la llanta' });
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
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    expect(view.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._store?.reassignCount).toBe(2);
  });

  it('reassignCount > MAX (default 3) → FAILED terminal (NO REASSIGNING) + emite trip.failed (pasajero notificado)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-3', passengerId: 'pax-3', reassignCount: 3 }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    // 4 > 3 → NO re-puja: cae a terminal honesto FAILED.
    expect(view.status).toBe(TripStatus.FAILED);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
    const failed = prisma._outbox.find((e) => e.eventType === 'trip.failed');
    expect(failed).toBeTruthy();
    const payload = failed?.envelope.payload as { tripId: string; passengerId: string; fromStatus: string };
    expect(payload.passengerId).toBe('pax-3'); // el pasajero recibe la notificación
    expect(payload.fromStatus).toBe(TripStatus.ACCEPTED);
    expect(prisma._store?.reassignCount).toBe(4);
  });

  it('cancel del CONDUCTOR desde ARRIVED → REASSIGNING', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ARRIVED, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    expect(view.status).toBe(TripStatus.REASSIGNING);
  });

  it('cancel del CONDUCTOR desde ASSIGNED (pre-accept) sigue siendo terminal CANCELLED_BY_DRIVER', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.ASSIGNED, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    expect(view.status).toBe(TripStatus.CANCELLED_BY_DRIVER);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.cancelled')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
  });

  // ADR 011 §1.2/§4 · la reasignación respeta el dispatchMode CONGELADO del viaje (no re-resuelve).
  it('FIXED · driver cancela post-accept → REASSIGNING + emite trip.requested (NO trip.reassigning)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1', dispatchMode: 'FIXED', fareCents: 1500 }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    expect(view.status).toBe(TripStatus.REASSIGNING);
    // FIXED re-despacha el flujo de tarifa fija: trip.requested, NO la puja (trip.reassigning).
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(false);
    // El conductor que canceló se desvincula para el re-match.
    expect(prisma._store?.driverId).toBeNull();
    // La tarifa fija NO cambia (BR-T01 inmutable).
    expect(prisma._store?.fareCents).toBe(1500);
    expect(prisma._store?.reassignCount).toBe(1);
  });

  it('PUJA · driver cancela post-accept → REASSIGNING + emite trip.reassigning (NO trip.requested)', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1', dispatchMode: 'PUJA' }),
    );
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.cancel('trip-1', { by: 'DRIVER' });
    expect(view.status).toBe(TripStatus.REASSIGNING);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.reassigning')).toBe(true);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.requested')).toBe(false);
  });
});

describe('TripsService.rebid · RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4)', () => {
  const PAX = 'pax-1';

  it('rebid desde REASSIGNING con un bid mayor → REQUESTED + fareCents actualizado + emite trip.bid_posted', async () => {
    const prisma = makePrisma(
      buildTrip({ status: TripStatus.REASSIGNING, passengerId: PAX, driverId: 'drv-old', fareCents: 900, reassignCount: 2 }),
    );
    const svc = new TripsService(prisma as never, maps);
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
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 800 }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.rebid('trip-1', PAX, 1100);
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(1100);
    expect(prisma._outbox.some((e) => e.eventType === 'trip.bid_posted')).toBe(true);
  });

  it('rebid permite CUALQUIER valor en [floor, techo] — no fuerza a subir (regla documentada)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 2000 }));
    const svc = new TripsService(prisma as never, maps);
    // bid MENOR al anterior pero ≥ piso (700 default): se acepta.
    const view = await svc.rebid('trip-1', PAX, 750);
    expect(view.status).toBe(TripStatus.REQUESTED);
    expect(view.fareCents).toBe(750);
  });

  it('rebid desde un estado inválido (IN_PROGRESS) → ConflictError (no emite eventos)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.IN_PROGRESS, passengerId: PAX, driverId: 'drv-1' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
    expect(prisma._outbox).toHaveLength(0);
    expect(prisma._store?.status).toBe(TripStatus.IN_PROGRESS);
  });

  it('rebid desde un estado terminal (COMPLETED) → ConflictError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.COMPLETED, passengerId: PAX }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rebid por DEBAJO del piso → ValidationError (no emite eventos)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 100)).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('rebid por ENCIMA del techo (BID_MAX_CENTS) → ValidationError', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 999_999_999)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rebid de un viaje AJENO → NotFoundError (no se filtra existencia ajena, ownership server-side)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: 'otro-pax' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('rebid de un viaje inexistente → NotFoundError', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('doble-tap (carrera): el guard updateMany evita la doble apertura de board — el 2º rebid es no-op idempotente', async () => {
    // Modela DOS taps concurrentes que ambos LEYERON EXPIRED. El 1º gana el guard (status→REQUESTED).
    // El 2º entra a la tx con el where status=EXPIRED, pero el store YA es REQUESTED → count 0 → no re-emite.
    const prisma = makePrisma(buildTrip({ status: TripStatus.EXPIRED, passengerId: PAX, fareCents: 1500 }));
    const svc = new TripsService(prisma as never, maps);

    // 1er tap: gana, abre board fresco.
    const first = await svc.rebid('trip-1', PAX, 1500);
    expect(first.status).toBe(TripStatus.REQUESTED);
    const boardsAfterFirst = prisma._outbox.filter((e) => e.eventType === 'trip.bid_posted').length;
    expect(boardsAfterFirst).toBe(1);

    // 2º tap: el viaje ya es REQUESTED. El gate REBIDDABLE lo rechaza ANTES de abrir un 2º board.
    await expect(svc.rebid('trip-1', PAX, 1500)).rejects.toBeInstanceOf(ConflictError);
    const boardsAfterSecond = prisma._outbox.filter((e) => e.eventType === 'trip.bid_posted').length;
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
    const svc = new TripsService(prisma as never, maps);

    // Driver cancela post-accept → REASSIGNING. La re-negociación RESETEA el guard once-ever Y bumpea el ciclo.
    const view = await svc.cancel('trip-1', { by: 'DRIVER', reason: 'se me pinchó la llanta' });
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
    const svc = new TripsService(prisma as never, maps);

    // 1) driver cancela → REASSIGNING (guard reseteado + ciclo 1 → 2 por la reasignación automática).
    await svc.cancel('trip-1', { by: 'DRIVER' });
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
      buildTrip({ status: TripStatus.ACCEPTED, driverId: 'drv-1', fareCents: 900, agreedFareCents: null }),
    );
    const svc = new TripsService(prisma as never, maps);

    await svc.applyAgreedFare('trip-1', 900, 1); // 1ª aplicación: marca agreedFareCents=900
    expect(prisma._store?.agreedFareCents).toBe(900);
    const eventsAfterFirst = prisma._tripEvents.filter((e) => e.eventType === 'trip.fare_agreed').length;
    expect(eventsAfterFirst).toBe(1);

    await svc.applyAgreedFare('trip-1', 900, 1); // redelivery del MISMO evento: NO-OP
    expect(prisma._store?.agreedFareCents).toBe(900); // sin cambios
    const eventsAfterSecond = prisma._tripEvents.filter((e) => e.eventType === 'trip.fare_agreed').length;
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
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.complete('trip-1', { cashCollected: true });
    expect(view.status).toBe(TripStatus.COMPLETED);
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('CASH');
    expect(payload?.cashCollected).toBe(true);
  });

  it('viaje CASH sin cashCollected → cashCollected ausente (undefined): flujo bilateral normal', async () => {
    const prisma = makePrisma(inProgressCash());
    const svc = new TripsService(prisma as never, maps);
    await svc.complete('trip-1'); // sin dto (default {})
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('CASH');
    expect(payload?.cashCollected).toBeUndefined();
  });

  it('viaje DIGITAL (YAPE) ignora el flag: cashCollected NO viaja aunque se mande true', async () => {
    const prisma = makePrisma(inProgressCash(PaymentMethod.YAPE));
    const svc = new TripsService(prisma as never, maps);
    await svc.complete('trip-1', { cashCollected: true });
    const payload = completedPayload(prisma);
    expect(payload?.paymentMethod).toBe('YAPE');
    expect(payload?.cashCollected).toBeUndefined(); // digital: el flag es ruido, no se propaga
  });

  it('anti-IDOR: un driverId que no es el del viaje → 404 (NotFoundError), no completa', async () => {
    const prisma = makePrisma(inProgressCash());
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.complete('trip-1', { driverId: 'drv-OTRO', cashCollected: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(prisma._store?.status).toBe(TripStatus.IN_PROGRESS); // sin transición
  });
});
