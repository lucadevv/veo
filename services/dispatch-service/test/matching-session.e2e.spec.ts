/**
 * E2E del matching SECUENCIAL event-driven (D2.1) sobre Postgres REAL (testcontainers).
 *
 * Ejercita el advance STATELESS (offerNext) sin estado en proceso: startSession crea la DispatchSession
 * y oferta al primer candidato; cada reject hace avanzar al siguiente; al agotarse cierra TIMED_OUT y
 * publica dispatch.timeout. "Una oferta a la vez" y los cierres CAS se verifican contra la DB de verdad.
 * (Vive en test/ — excluido de tsc — porque usa testcontainers/import.meta, igual que los e2e de payment/trip.)
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7, toH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import { PrismaClient, DispatchOutcome, DispatchSessionStatus } from '../src/generated/prisma';
import { MatchingService } from '../src/dispatch/matching.service';
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
      new Map(ids.map((id) => [id, { avgRating: 5, secondsSinceLastTrip: 1_000_000_000, cancellationRate: 0 }])),
  };
  const surge = {
    quote: async () => ({ multiplier: 1, zoneId: null, zoneName: null, active: false, demand: 0, supply: 0, ratio: 0 }),
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
    DISPATCH_REJECTS_BEFORE_EXPAND: 5,
    DISPATCH_MAX_K_RING: 2,
  } as Partial<Env> as Env);

  matching = new MatchingService(
    prismaService,
    hotIndex,
    driverPool,
    sessions,
    scorer,
    projection as never,
    surge as never,
    maps as never,
    offerDelivery,
    config,
  );
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

async function timeoutEvents(tripId: string) {
  return prisma.outboxEvent.findMany({ where: { aggregateId: tripId, eventType: 'dispatch.timeout' } });
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
    const offeredCount = await prisma.dispatchMatch.count({ where: { tripId, outcome: DispatchOutcome.OFFERED } });
    expect(offeredCount).toBe(1);
  });

  it('reject → offerNext oferta al SIGUIENTE candidato; exhaustión → TIMED_OUT + dispatch.timeout', async () => {
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
    const inFlight = await prisma.dispatchMatch.findFirst({ where: { tripId, outcome: DispatchOutcome.OFFERED } });
    expect(inFlight).not.toBeNull();
    expect(inFlight!.driverId).not.toBe(first); // el SEGUNDO candidato, no el ya rechazado
    expect([d1, d2]).toContain(inFlight!.driverId);

    // Reject del segundo → no quedan candidatos → cierre TIMED_OUT + evento.
    await rejectInFlight(tripId);
    await matching.offerNext(tripId);
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(await timeoutEvents(tripId)).toHaveLength(1);
  });

  it('sin conductores disponibles → startSession cierra TIMED_OUT y publica dispatch.timeout', async () => {
    const tripId = uuidv7();
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
    const session = await prisma.dispatchSession.findUnique({ where: { tripId } });
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(await prisma.dispatchMatch.count({ where: { tripId } })).toBe(0);
    expect(await timeoutEvents(tripId)).toHaveLength(1);
  });

  it('offerNext sobre una sesión ya cerrada (TIMED_OUT) es no-op', async () => {
    const tripId = uuidv7();
    await matching.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR }); // → TIMED_OUT (sin drivers)
    const before = await timeoutEvents(tripId);
    await matching.offerNext(tripId); // no-op: sesión no-OPEN
    expect(await timeoutEvents(tripId)).toHaveLength(before.length); // no re-publica
    expect(await prisma.dispatchMatch.count({ where: { tripId } })).toBe(0);
  });
});
