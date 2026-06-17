/**
 * E2E del matching SECUENCIAL event-driven (D2.1) sobre Postgres REAL (testcontainers).
 *
 * Ejercita el advance STATELESS (offerNext) sin estado en proceso: startSession crea la DispatchSession
 * y oferta al primer candidato; cada reject hace avanzar al siguiente; al agotarse cierra TIMED_OUT y
 * publica dispatch.no_offers. "Una oferta a la vez" y los cierres CAS se verifican contra la DB de verdad.
 * (Vive en test/ — excluido de tsc — porque usa testcontainers/import.meta, igual que los e2e de payment/trip.)
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7, toH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { VehicleType, OfferingId, FleetDocumentType } from '@veo/shared-types';
import { PrismaClient, DispatchOutcome, DispatchSessionStatus } from '../src/generated/prisma';
import { MatchingService } from '../src/dispatch/matching.service';
import { DispatchService } from '../src/dispatch/dispatch.service';
import type { DispatchOffer } from '../src/dispatch/offer-delivery.port';
import { MatchingSessionStore } from '../src/dispatch/matching-session.store';
import { DriverPool } from '../src/dispatch/driver-pool';
import { DispatchScorer } from '../src/dispatch/scoring';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../src/hot-index/in-memory-hot-index';
import type { PrismaService } from '../src/infra/prisma.service';
import type { Env } from '../src/config/env.schema';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const CENTER = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);

let db: TestDatabase;
let prisma: PrismaClient;
let matching: MatchingService;
let dispatch: DispatchService;
let hotIndex: InMemoryHotIndex;
let offered: string[];

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'dispatch',
    applyMigrations: (url: string) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;

  hotIndex = new InMemoryHotIndex();
  const exclusion = new InMemoryExclusionRegistry();
  const driverPool = new DriverPool(hotIndex, exclusion);
  const sessions = new MatchingSessionStore(prismaService);
  const scorer = new DispatchScorer({ distance: 5000, rating: 1, idle: 10, cancel: 5 });
  const projection = {
    getStats: async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          { avgRating: 5, secondsSinceLastTrip: 1_000_000_000, cancellationRate: 0 },
        ]),
      ),
  };
  const surge = {
    quote: async () => ({
      multiplier: 1,
      zoneId: null,
      zoneName: null,
      active: false,
      demand: 0,
      supply: 0,
      ratio: 0,
    }),
  };
  const maps = { eta: async () => 60 };
  offered = [];
  const offerDelivery = {
    deliver: (offer: DispatchOffer): void => {
      offered.push(offer.driverId);
    },
  };
  const config = new ConfigService<Env, true>({
    DISPATCH_OFFER_TIMEOUT_MS: 12_000,
    DISPATCH_MAX_K_RING: 2,
  } as Partial<Env> as Env);

  matching = new MatchingService(
    prismaService,
    driverPool,
    sessions,
    scorer,
    projection as never,
    surge as never,
    maps as never,
    offerDelivery,
    config,
  );
  // DispatchService (accept/reject del conductor) comparte el mismo matching + hot-index reales.
  // Fakes de fleet+identity: este e2e no ejercita la resolución de vehículo (camino fail-soft → null).
  const fleet = { getActiveVehicleId: async (): Promise<string | null> => null };
  const identity = {
    getDriver: async (id: string) => ({
      id,
      userId: id,
      currentStatus: 'AVAILABLE',
      suspendedAt: null,
      found: true,
    }),
  };
  dispatch = new DispatchService(prismaService, hotIndex, exclusion, fleet, identity, matching);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

// Aislamiento entre casos: el hot-index (fake en memoria) es compartido → se vacía antes de cada test
// para que el pool de conductores de un caso no contamine al siguiente. Los tripId son únicos (uuidv7)
// así que las filas en la DB no colisionan entre casos.
beforeEach(async () => {
  await hotIndex.clear();
  offered.length = 0;
});

/** Marca el ÚNICO match OFFERED del viaje como REJECTED (simula la respuesta del conductor). */
async function rejectInFlight(tripId: string): Promise<void> {
  await prisma.dispatchMatch.updateMany({
    where: { tripId, outcome: DispatchOutcome.OFFERED },
    data: { outcome: DispatchOutcome.REJECTED, respondedAt: new Date() },
  });
}

async function noOffersEvents(tripId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateId: tripId, eventType: 'dispatch.no_offers' },
  });
}

describe('Matching secuencial event-driven (D2.1: DispatchSession + offerNext)', () => {
  it('startSession abre la sesión OPEN y oferta al primer candidato (una sola oferta)', async () => {
    const tripId = uuidv7();
    const d1 = uuidv7();
    const d2 = uuidv7();
    await hotIndex.seed(d1, ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(d2, ORIGIN.lat, ORIGIN.lon, CENTER);

    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });

    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.OPEN);
    const matches = await prisma.dispatchMatch.findMany({ where: { tripId } });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.outcome).toBe(DispatchOutcome.OFFERED);
    expect([d1, d2]).toContain(matches[0]!.driverId);
    expect(offered).toContain(matches[0]!.driverId);
  });

  it('offerNext con una oferta EN VUELO no encima otra (una oferta a la vez)', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });

    await matching.offerNext(tripId); // re-entra con un OFFERED vivo
    const offeredCount = await prisma.dispatchMatch.count({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(offeredCount).toBe(1);
  });

  it('reject → offerNext oferta al SIGUIENTE candidato; exhaustión → TIMED_OUT + dispatch.no_offers', async () => {
    const tripId = uuidv7();
    const d1 = uuidv7();
    const d2 = uuidv7();
    await hotIndex.seed(d1, ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(d2, ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });

    const first = (await prisma.dispatchMatch.findFirst({ where: { tripId } }))!.driverId;

    // Reject del primero → avanza al segundo.
    await rejectInFlight(tripId);
    await matching.offerNext(tripId);
    const inFlight = await prisma.dispatchMatch.findFirst({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(inFlight).not.toBeNull();
    expect(inFlight!.driverId).not.toBe(first); // el SEGUNDO candidato, no el ya rechazado
    expect([d1, d2]).toContain(inFlight!.driverId);

    // Reject del segundo → no quedan candidatos → cierre TIMED_OUT + evento.
    await rejectInFlight(tripId);
    await matching.offerNext(tripId);
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(await noOffersEvents(tripId)).toHaveLength(1);
  });

  it('sin conductores disponibles → startSession cierra TIMED_OUT y publica dispatch.no_offers', async () => {
    const tripId = uuidv7();
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(await prisma.dispatchMatch.count({ where: { tripId } })).toBe(0);
    expect(await noOffersEvents(tripId)).toHaveLength(1);
  });

  it('offerNext sobre una sesión ya cerrada (TIMED_OUT) es no-op', async () => {
    const tripId = uuidv7();
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR }); // → TIMED_OUT (sin drivers)
    const before = await noOffersEvents(tripId);
    await matching.offerNext(tripId); // no-op: sesión no-OPEN
    expect(await noOffersEvents(tripId)).toHaveLength(before.length); // no re-publica
    expect(await prisma.dispatchMatch.count({ where: { tripId } })).toBe(0);
  });
});

describe('Respuesta reactiva del conductor (D2.2: accept/reject por ESTADO, sin respond() in-process)', () => {
  async function matchFoundEvents(tripId: string) {
    return prisma.outboxEvent.findMany({
      where: { aggregateId: tripId, eventType: 'dispatch.match_found' },
    });
  }

  it('accept → match ACCEPTED, sesión MATCHED y UN match_found con dedupKey determinista', async () => {
    const tripId = uuidv7();
    const driver = uuidv7();
    await hotIndex.seed(driver, ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const offered = await prisma.dispatchMatch.findFirstOrThrow({ where: { tripId } });
    const matchId = offered.id;

    const view = await dispatch.accept(matchId, offered.driverId);
    expect(view.outcome).toBe(DispatchOutcome.ACCEPTED);

    const match = await prisma.dispatchMatch.findUniqueOrThrow({ where: { id: matchId } });
    expect(match.outcome).toBe(DispatchOutcome.ACCEPTED);
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.MATCHED);

    const events = await matchFoundEvents(tripId);
    expect(events).toHaveLength(1);
    const envelope = events[0]!.envelope as { dedupKey: string; payload: { driverId: string } };
    expect(envelope.dedupKey).toBe(`match_found:${tripId}:${match.driverId}`);
  });

  it('accept dos veces (retry) → el segundo es Conflict y NO emite un segundo match_found', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const offered = await prisma.dispatchMatch.findFirstOrThrow({ where: { tripId } });
    const matchId = offered.id;

    await dispatch.accept(matchId, offered.driverId);
    await expect(dispatch.accept(matchId, offered.driverId)).rejects.toThrow(); // ya no está OFFERED → Conflict
    expect(await matchFoundEvents(tripId)).toHaveLength(1);
  });

  it('reject → match REJECTED, avanza al SIGUIENTE candidato y la sesión sigue OPEN', async () => {
    const tripId = uuidv7();
    const d1 = uuidv7();
    const d2 = uuidv7();
    await hotIndex.seed(d1, ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(d2, ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const firstMatch = await prisma.dispatchMatch.findFirstOrThrow({ where: { tripId } });

    const view = await dispatch.reject(firstMatch.id, firstMatch.driverId);
    expect(view.outcome).toBe(DispatchOutcome.REJECTED);

    // El reject disparó offerNext → hay un nuevo OFFERED al OTRO conductor.
    const inFlight = await prisma.dispatchMatch.findFirstOrThrow({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(inFlight.driverId).not.toBe(firstMatch.driverId);
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.OPEN);
    expect(await matchFoundEvents(tripId)).toHaveLength(0); // un reject no produce match
  });

  it('trip.cancelled → cancelSession cierra CANCELLED y offerNext deja de ofertar', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });

    await matching.cancelSession(tripId);
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.CANCELLED);

    // Aún con un OFFERED vivo, marcar la respuesta y avanzar NO debe re-ofertar (sesión no-OPEN).
    await prisma.dispatchMatch.updateMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
      data: { outcome: DispatchOutcome.REJECTED, respondedAt: new Date() },
    });
    await matching.offerNext(tripId);
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.OFFERED } }),
    ).toBe(0);
  });
});

describe('Reconciler de timeout durable (D2.3: sweepExpiredOffers, reemplaza el setTimeout)', () => {
  /**
   * Simula el paso del tiempo: backdatea la sesión (inicio de ronda) Y su oferta OFFERED para que la
   * oferta quede vencida (offeredAt > 12s atrás) pero SIGA siendo de la ronda actual (offeredAt ≥ createdAt).
   * En producción createdAt y offeredAt envejecen juntos; el test comprime el tiempo manteniendo ese orden.
   */
  async function expireInFlight(tripId: string): Promise<void> {
    await prisma.dispatchSession.update({
      where: { tripId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await prisma.dispatchMatch.updateMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
      data: { offeredAt: new Date(Date.now() - 30_000) }, // vencida (>12s) pero ≥ createdAt (60s atrás)
    });
  }

  it('oferta vencida con otro candidato → sweep la marca TIMEOUT y oferta al siguiente', async () => {
    const tripId = uuidv7();
    const d1 = uuidv7();
    const d2 = uuidv7();
    await hotIndex.seed(d1, ORIGIN.lat, ORIGIN.lon, CENTER);
    await hotIndex.seed(d2, ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const first = await prisma.dispatchMatch.findFirstOrThrow({ where: { tripId } });
    await expireInFlight(tripId);

    const advanced = await matching.sweepExpiredOffers();
    expect(advanced).toBe(1);

    expect(
      (await prisma.dispatchMatch.findUniqueOrThrow({ where: { id: first.id } })).outcome,
    ).toBe(DispatchOutcome.TIMEOUT);
    const inFlight = await prisma.dispatchMatch.findFirstOrThrow({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(inFlight.driverId).not.toBe(first.driverId); // avanzó al segundo
  });

  it('oferta vencida sin más candidatos → sweep cierra TIMED_OUT + dispatch.no_offers', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    await expireInFlight(tripId);

    await matching.sweepExpiredOffers();
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(await noOffersEvents(tripId)).toHaveLength(1);
  });

  it('una oferta FRESCA (no vencida) no se barre', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });

    const advanced = await matching.sweepExpiredOffers();
    expect(advanced).toBe(0);
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.OFFERED } }),
    ).toBe(1);
  });

  it('barrido doble (dos réplicas) reclama la oferta UNA sola vez (CAS)', async () => {
    const tripId = uuidv7();
    await hotIndex.seed(uuidv7(), ORIGIN.lat, ORIGIN.lon, CENTER);
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    await expireInFlight(tripId);

    const [a, b] = await Promise.all([
      matching.sweepExpiredOffers(),
      matching.sweepExpiredOffers(),
    ]);
    expect(a + b).toBe(1); // exactamente una réplica reclamó la oferta vencida
  });
});

describe('Broadcast EMERGENCY (ambulancia · B5-vert: oferta SIMULTÁNEA, primero que acepta gana)', () => {
  const AMB = OfferingId.VEO_AMBULANCE; // flow EMERGENCY + requires.certifications=[AMBULANCE_OPERATOR]
  const certs = { certifications: [FleetDocumentType.AMBULANCE_OPERATOR] };

  async function withdrawnEvents(tripId: string) {
    return prisma.outboxEvent.findMany({
      where: { aggregateId: tripId, eventType: 'dispatch.offer_withdrawn' },
    });
  }

  it('startSession EMERGENCY oferta a TODOS los conductores certificados a la vez (broadcast, no uno)', async () => {
    const tripId = uuidv7();
    const drivers = [uuidv7(), uuidv7(), uuidv7()];
    for (const d of drivers)
      await hotIndex.seed(d, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);

    await matching.startSession({
      tripId,
      origin: ORIGIN,
      requiredVehicleType: VehicleType.CAR,
      category: AMB,
    });

    const offers = await prisma.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(offers).toHaveLength(3); // broadcast: 3 ofertas vivas a la vez (el secuencial daría 1)
    expect(offered.sort()).toEqual([...drivers].sort()); // entregadas a los 3
  });

  it('FAIL-CLOSED en el broadcast: un conductor SIN cert no recibe la oferta de ambulancia', async () => {
    const tripId = uuidv7();
    const withCert = uuidv7();
    const noCert = uuidv7();
    await hotIndex.seed(withCert, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);
    await hotIndex.seed(noCert, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR); // sin certs

    await matching.startSession({
      tripId,
      origin: ORIGIN,
      requiredVehicleType: VehicleType.CAR,
      category: AMB,
    });

    const offers = await prisma.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(offers.map((o) => o.driverId)).toEqual([withCert]); // solo el certificado
  });

  it('el primero que acepta gana: sesión MATCHED + las hermanas → TIMEOUT + offer_withdrawn(taken)', async () => {
    const tripId = uuidv7();
    const drivers = [uuidv7(), uuidv7(), uuidv7()];
    for (const d of drivers)
      await hotIndex.seed(d, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);
    await matching.startSession({
      tripId,
      origin: ORIGIN,
      requiredVehicleType: VehicleType.CAR,
      category: AMB,
    });

    const all = await prisma.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    const winner = all[0]!;
    await dispatch.accept(winner.id, winner.driverId);

    // El ganador queda ACCEPTED; la sesión MATCHED.
    expect(
      (await prisma.dispatchMatch.findUniqueOrThrow({ where: { id: winner.id } })).outcome,
    ).toBe(DispatchOutcome.ACCEPTED);
    expect((await prisma.dispatchSession.findUnique({ where: { tripId } }))?.status).toBe(
      DispatchSessionStatus.MATCHED,
    );
    // Las 2 hermanas: retiradas a TIMEOUT, ninguna queda OFFERED.
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.OFFERED } }),
    ).toBe(0);
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.TIMEOUT } }),
    ).toBe(2);
    // Y se avisó a los 2 perdedores con offer_withdrawn(reason: taken).
    const withdrawn = await withdrawnEvents(tripId);
    expect(withdrawn).toHaveLength(2);
    const losers = all
      .filter((m) => m.id !== winner.id)
      .map((m) => m.driverId)
      .sort();
    expect(
      withdrawn
        .map((e) => (e.envelope as { payload: { driverId: string } }).payload.driverId)
        .sort(),
    ).toEqual(losers);
    expect((withdrawn[0]!.envelope as { payload: { reason: string } }).payload.reason).toBe(
      'taken',
    );
  });

  it('EMERGENCY sin aceptación: todas las ofertas del broadcast expiran y sin más candidatos → TIMED_OUT honesto', async () => {
    const tripId = uuidv7();
    const drivers = [uuidv7(), uuidv7()];
    for (const d of drivers)
      await hotIndex.seed(d, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);
    await matching.startSession({
      tripId,
      origin: ORIGIN,
      requiredVehicleType: VehicleType.CAR,
      category: AMB,
    });
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.OFFERED } }),
    ).toBe(2);

    // Simula el paso del tiempo: backdatea la ronda + las 2 ofertas para que venzan (>12s) sin salir de la ronda.
    await prisma.dispatchSession.update({
      where: { tripId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await prisma.dispatchMatch.updateMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
      data: { offeredAt: new Date(Date.now() - 30_000) },
    });

    await matching.sweepExpiredOffers(); // marca las 2 TIMEOUT y re-invoca offerNext → offerBroadcast
    // Sin candidatos NUEVOS (los 2 ya intentados) y sin ofertas vivas → cierre honesto.
    expect((await prisma.dispatchSession.findUnique({ where: { tripId } }))?.status).toBe(
      DispatchSessionStatus.TIMED_OUT,
    );
    expect(await noOffersEvents(tripId)).toHaveLength(1);
  });

  it('CARRERA real: dos aceptan ofertas distintas del MISMO viaje a la vez → solo UNO gana (índice UNIQUE PARCIAL)', async () => {
    const tripId = uuidv7();
    const d1 = uuidv7();
    const d2 = uuidv7();
    await hotIndex.seed(d1, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);
    await hotIndex.seed(d2, ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR, certs);
    await matching.startSession({
      tripId,
      origin: ORIGIN,
      requiredVehicleType: VehicleType.CAR,
      category: AMB,
    });

    const offers = await prisma.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    expect(offers).toHaveLength(2);

    // Ambos aceptan SU oferta concurrentemente: el índice UNIQUE PARCIAL (tripId WHERE ACCEPTED) deja UNO.
    const results = await Promise.allSettled(offers.map((o) => dispatch.accept(o.id, o.driverId)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // exactamente un ganador
    expect(rejected).toHaveLength(1); // el otro → ConflictError (P2002 traducido)
    // En la DB: exactamente UN ACCEPTED para el viaje.
    expect(
      await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.ACCEPTED } }),
    ).toBe(1);
  });
});
