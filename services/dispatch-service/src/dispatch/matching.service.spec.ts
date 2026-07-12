/**
 * MatchingService — matcher FIXED secuencial. Cubre la POLÍTICA v2 (feature-flag) y verifica que el camino
 * v1 (flag off) queda intacto. El lookup espacial (DriverPool/hot-index/neighbors) es real en memoria; solo
 * la política de radios/umbral cambia entre v1 y v2.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { toH3, neighbors, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import { MatchingService } from './matching.service';
import { MatchingSessionStore } from './matching-session.store';
import { DriverPool } from './driver-pool';
import { DispatchScorer } from './scoring';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import { DispatchSessionStatus, type DispatchSession } from '../generated/prisma';
import type { MatchingSessionRepository, SessionSeed } from './matching-session.repository';
import type { MatchingRepository } from './matching.repository';
import type { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import type { DispatchPolicyV2 } from './dispatch-policy';
import type { Env } from '../config/env.schema';

const ORIGIN: LatLon = { lat: -12.0464, lon: -77.0428 };

/** Sesión durable en memoria (mismo contrato que PrismaMatchingSessionRepository). */
class InMemorySessionRepo implements MatchingSessionRepository {
  readonly rows = new Map<string, DispatchSession>();

  async upsert(tripId: string, seed: SessionSeed): Promise<DispatchSession> {
    const row: DispatchSession = {
      tripId,
      status: seed.status,
      originLat: seed.originLat,
      originLon: seed.originLon,
      vehicleType: seed.vehicleType as DispatchSession['vehicleType'],
      category: seed.category,
      currentKRing: seed.currentKRing,
      nextExpandAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(tripId, row);
    return row;
  }
  async find(tripId: string): Promise<DispatchSession | null> {
    return this.rows.get(tripId) ?? null;
  }
  async updateKRing(tripId: string, kRing: number): Promise<void> {
    const r = this.rows.get(tripId);
    if (r) r.currentKRing = kRing;
  }
  async updateExpansion(tripId: string, kRing: number, nextExpandAt: Date | null): Promise<void> {
    const r = this.rows.get(tripId);
    if (r) {
      r.currentKRing = kRing;
      r.nextExpandAt = nextExpandAt;
    }
  }
  async findExpandable(now: Date, maxK: number, limit: number) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.status === DispatchSessionStatus.OPEN &&
          r.nextExpandAt !== null &&
          r.nextExpandAt <= now &&
          r.currentKRing < maxK,
      )
      .sort((a, b) => (a.nextExpandAt!.getTime() - b.nextExpandAt!.getTime()))
      .slice(0, limit)
      .map((r) => ({ tripId: r.tripId, currentKRing: r.currentKRing }));
  }
  async advanceExpansion(
    tripId: string,
    fromK: number,
    toK: number,
    nextExpandAt: Date | null,
  ): Promise<number> {
    const r = this.rows.get(tripId);
    if (!r || r.status !== DispatchSessionStatus.OPEN || r.currentKRing !== fromK) return 0;
    r.currentKRing = toK;
    r.nextExpandAt = nextExpandAt;
    return 1;
  }
  async closeIfOpen(tripId: string, status: DispatchSessionStatus): Promise<number> {
    const r = this.rows.get(tripId);
    if (!r || r.status !== DispatchSessionStatus.OPEN) return 0;
    r.status = status;
    return 1;
  }
}

interface CreatedOffer {
  id: string;
  tripId: string;
  driverId: string;
  offeredAt: Date;
}

/** Repo de matching en memoria: registra las ofertas creadas (para contar single-offer) + outbox. */
class InMemoryMatchingRepo implements MatchingRepository {
  readonly offers: CreatedOffer[] = [];
  readonly outbox: { eventType: string; payload: unknown }[] = [];
  private seq = 0;

  async runInTx<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    const tx = {
      outboxEvent: {
        create: async ({ data }: { data: { eventType: string; envelope: { payload: unknown } } }) => {
          this.outbox.push({ eventType: data.eventType, payload: data.envelope.payload });
        },
      },
    };
    return fn(tx as never);
  }
  async countLiveOffers(tripId: string): Promise<number> {
    return this.offers.filter((o) => o.tripId === tripId).length;
  }
  async findRoundDriverIds(tripId: string): Promise<{ driverId: string }[]> {
    return this.offers.filter((o) => o.tripId === tripId).map((o) => ({ driverId: o.driverId }));
  }
  async findRoundMatches(tripId: string) {
    return this.offers
      .filter((o) => o.tripId === tripId)
      .map((o) => ({ driverId: o.driverId, outcome: 'OFFERED' as never }));
  }
  async findExpiredOffers() {
    return [];
  }
  async timeoutOffer() {
    return 1;
  }
  async createOffer(input: {
    id: string;
    tripId: string;
    driverId: string;
  }): Promise<never> {
    this.seq += 1;
    const row = { ...input, offeredAt: new Date(Date.now() - 1000) };
    this.offers.push({ id: input.id, tripId: input.tripId, driverId: input.driverId, offeredAt: row.offeredAt });
    return row as never;
  }
}

const V2_POLICY: DispatchPolicyV2 = {
  FIXED: {
    initialRadiusKm: 0.3, // startK = 1
    incrementKm: 0.3,
    maxRadiusKm: 1.5, // maxK = 5
    targetDrivers: 3,
    offerTimeoutSec: 20,
    expandIntervalSec: 8,
  },
  PUJA: { broadcastRadiusKm: 1.2, bidWindowSec: 60 },
};

interface Ctx {
  svc: MatchingService;
  sessionRepo: InMemorySessionRepo;
  matchingRepo: InMemoryMatchingRepo;
  hotIndex: InMemoryHotIndex;
  delivered: string[];
  policy: { policyVersion: 'v1' | 'v2'; v2: DispatchPolicyV2 | null };
}

function makeCtx(): Ctx {
  const sessionRepo = new InMemorySessionRepo();
  const sessions = new MatchingSessionStore(sessionRepo);
  const matchingRepo = new InMemoryMatchingRepo();
  const hotIndex = new InMemoryHotIndex();
  const driverPool = new DriverPool(hotIndex, new InMemoryExclusionRegistry(), new InMemoryExclusionRegistry());
  const scorer = new DispatchScorer({ distance: 5000, rating: 1, idle: 10, cancel: 5 });
  const projection = { getStats: async () => new Map() } as never;
  const surge = { quote: async () => ({ multiplier: 1 }) } as never;
  const maps = { eta: async () => 60 } as never;
  const delivered: string[] = [];
  const offerDelivery = { deliver: async (o: { driverId: string }) => void delivered.push(o.driverId) } as never;
  const policy: Ctx['policy'] = { policyVersion: 'v1', v2: null };
  const radiusConfig = {
    getPolicy: async () => ({ policyVersion: policy.policyVersion, v2: policy.v2 }),
    getWindows: async () => ({ offerTimeoutMs: 20_000, bidWindowSec: 60 }),
    getKRings: async () => ({ nearbyKRing: 3, matchKRing: 4 }),
  } as unknown as DispatchRadiusConfigService;
  const config = new ConfigService<Env, true>({
    DISPATCH_MAX_K_RING: 2,
    DISPATCH_SWEEP_ADVANCE_BUDGET: 25,
    DISPATCH_SWEEP_DEADLINE_MS: 1500,
  } as Partial<Env> as Env);

  const svc = new MatchingService(
    matchingRepo as never,
    driverPool,
    sessions,
    scorer,
    projection,
    surge,
    maps,
    offerDelivery,
    radiusConfig,
    config,
  );
  return { svc, sessionRepo, matchingRepo, hotIndex, delivered, policy };
}

/** Celdas exactamente en el anillo `ring` (en el disco `ring` pero no en el `ring-1`). */
function cellsAtRing(center: string, ring: number): string[] {
  const inner = new Set(neighbors(center, ring - 1));
  return neighbors(center, ring).filter((c) => !inner.has(c));
}

async function startTrip(c: Ctx): Promise<string> {
  const tripId = 'trip-1';
  await c.svc.startSession({ tripId, origin: ORIGIN, requiredVehicleType: VehicleType.CAR });
  return tripId;
}

describe('MatchingService — política v2 (feature-flag)', () => {
  let c: Ctx;
  const center = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
  beforeEach(() => {
    c = makeCtx();
  });

  it('v2: EXPANDE el ring hasta juntar ≥ targetDrivers y oferta a UNO (single-offer preservado)', async () => {
    c.policy.policyVersion = 'v2';
    c.policy.v2 = V2_POLICY; // targetDrivers=3, startK=1, maxK=5
    // 1 candidato en el centro (ring 0/1) + 2 en el anillo 2 → recién en k=2 hay ≥3.
    await c.hotIndex.seed('d-center', ORIGIN.lat, ORIGIN.lon, center, VehicleType.CAR);
    const ring2 = cellsAtRing(center, 2);
    await c.hotIndex.seed('d-r2a', ORIGIN.lat, ORIGIN.lon, ring2[0]!, VehicleType.CAR);
    await c.hotIndex.seed('d-r2b', ORIGIN.lat, ORIGIN.lon, ring2[1]!, VehicleType.CAR);

    await startTrip(c);

    // UNA sola oferta (nunca broadcast: targetDrivers es un UMBRAL, no N destinatarios).
    expect(c.matchingRepo.offers).toHaveLength(1);
    expect(c.delivered).toHaveLength(1);
    // Expandió hasta el ring 2 (donde se juntó el umbral) y lo persistió + selló la cadencia de expansión.
    const session = await c.sessionRepo.find('trip-1');
    expect(session?.currentKRing).toBe(2);
    expect(session?.nextExpandAt).not.toBeNull(); // ring 2 < maxK 5 → hay expansión temporal pendiente
  });

  it('v2: sin candidatos hasta maxRadius → cierre honesto (TIMED_OUT + dispatch.no_offers)', async () => {
    c.policy.policyVersion = 'v2';
    c.policy.v2 = V2_POLICY;
    // Nadie en el hot-index.
    await startTrip(c);

    expect(c.matchingRepo.offers).toHaveLength(0);
    const session = await c.sessionRepo.find('trip-1');
    expect(session?.status).toBe(DispatchSessionStatus.TIMED_OUT);
    expect(c.matchingRepo.outbox.map((e) => e.eventType)).toContain('dispatch.no_offers');
  });

  it('v1 (flag off): oferta al PRIMER ring con candidatos (sin umbral) — camino histórico intacto', async () => {
    // policyVersion v1 por default. Mismo sembrado que el test v2.
    await c.hotIndex.seed('d-center', ORIGIN.lat, ORIGIN.lon, center, VehicleType.CAR);
    const ring2 = cellsAtRing(center, 2);
    await c.hotIndex.seed('d-r2a', ORIGIN.lat, ORIGIN.lon, ring2[0]!, VehicleType.CAR);
    await c.hotIndex.seed('d-r2b', ORIGIN.lat, ORIGIN.lon, ring2[1]!, VehicleType.CAR);

    await startTrip(c);

    // v1 oferta ya en k=1 (al candidato del centro), sin esperar a juntar 3: NO expande a ring 2.
    expect(c.matchingRepo.offers).toHaveLength(1);
    expect(c.delivered).toEqual(['d-center']);
    const session = await c.sessionRepo.find('trip-1');
    expect(session?.currentKRing).toBe(1); // no bumpeó
    expect(session?.nextExpandAt).toBeNull(); // v1 nunca sella la cadencia de expansión temporal
  });

  it('v2: sweepExpandableSessions ensancha el ring por TIEMPO (nextExpandAt vencido)', async () => {
    c.policy.policyVersion = 'v2';
    c.policy.v2 = V2_POLICY;
    // Una sesión OPEN parada en el ring 1 con expansión temporal YA vencida y sin oferta viva.
    const tripId = 'trip-exp';
    await c.sessionRepo.upsert(tripId, {
      originLat: ORIGIN.lat,
      originLon: ORIGIN.lon,
      vehicleType: VehicleType.CAR,
      category: null,
      status: DispatchSessionStatus.OPEN,
      currentKRing: 1,
    });
    const row = await c.sessionRepo.find(tripId);
    row!.nextExpandAt = new Date(Date.now() - 5_000); // vencido

    const expanded = await c.svc.sweepExpandableSessions();
    expect(expanded).toBe(1);
    // El ring se ensanchó 1 → 2 (piso más ancho para el próximo avance).
    expect((await c.sessionRepo.find(tripId))?.currentKRing).toBe(2);
  });

  it('v1: sweepExpandableSessions es no-op (no hay expansión temporal en v1)', async () => {
    const expanded = await c.svc.sweepExpandableSessions();
    expect(expanded).toBe(0);
  });
});
