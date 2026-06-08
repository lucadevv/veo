import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { toH3, fromH3, neighbors, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { DispatchOutcome, VehicleType } from '@veo/shared-types';
import { MatchingService } from './matching.service';
import { DispatchScorer } from './scoring';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import type { DispatchOffer } from './offer-delivery.port';
import type { Env } from '../config/env.schema';

const ORIGIN = { lat: -12.0464, lon: -77.0428 }; // Plaza de Armas de Lima
const CENTER = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);

interface CreatedMatch {
  driverId: string;
  attempt: number;
}
interface OutboxRow {
  aggregateId: string;
  eventType: string;
  envelope: { payload: { tripId: string; attemptedDrivers: number } };
}

function makeHarness() {
  const hotIndex = new InMemoryHotIndex();
  const exclusion = new InMemoryExclusionRegistry();
  const scorer = new DispatchScorer({ distance: 5000, rating: 1, idle: 10, cancel: 5 });

  const created: CreatedMatch[] = [];
  const outbox: OutboxRow[] = [];
  const offered: string[] = [];

  const prisma = {
    write: {
      dispatchMatch: {
        create: async ({ data }: { data: CreatedMatch }) => {
          created.push({ driverId: data.driverId, attempt: data.attempt });
          return data;
        },
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (fn: (tx: { outboxEvent: { create: (a: { data: OutboxRow }) => Promise<unknown> } }) => Promise<unknown>) =>
        fn({ outboxEvent: { create: async ({ data }: { data: OutboxRow }) => { outbox.push(data); return data; } } }),
    },
  };

  const projection = {
    getStats: async (ids: string[]) =>
      new Map(ids.map((id) => [id, { avgRating: 5, secondsSinceLastTrip: 1_000_000_000, cancellationRate: 0 }])),
  };
  const surge = {
    quote: async () => ({ multiplier: 1, zoneId: null, zoneName: null, active: false, demand: 0, supply: 0, ratio: 0 }),
  };
  const maps = { eta: async () => 60 };

  let strategy: (offer: DispatchOffer) => void = () => {};
  const offerDelivery = {
    deliver: (offer: DispatchOffer): void => {
      offered.push(offer.driverId);
      strategy(offer);
    },
  };

  const config = new ConfigService<Env, true>({
    DISPATCH_OFFER_TIMEOUT_MS: 30,
    DISPATCH_REJECTS_BEFORE_EXPAND: 5,
    DISPATCH_MAX_K_RING: 2,
  } as Partial<Env> as Env);

  const matching = new MatchingService(
    prisma as never,
    hotIndex,
    exclusion,
    scorer,
    projection as never,
    surge as never,
    maps as never,
    offerDelivery,
    config,
  );

  return {
    matching,
    hotIndex,
    exclusion,
    created,
    outbox,
    offered,
    setStrategy: (fn: (offer: DispatchOffer) => void) => {
      strategy = fn;
    },
  };
}

/** Devuelve una celda H3 que está en el k-ring radio 2 pero NO en el radio 1 del centro. */
function outerRing2Cell(): string {
  const ring1 = new Set(neighbors(CENTER, 1));
  const outer = neighbors(CENTER, 2).find((c) => !ring1.has(c));
  if (!outer) throw new Error('no se encontró celda exterior de radio 2');
  return outer;
}

describe('MatchingService · flujo de oferta (BR-T06)', () => {
  it('asigna al primer conductor que acepta y publica el resultado vía accept', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CENTER);
    await h.hotIndex.seed('d2', ORIGIN.lat, ORIGIN.lon, CENTER);
    h.setStrategy((offer) => h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED));

    const result = await h.matching.handleTripRequested({ tripId: 't1', origin: ORIGIN });

    expect(result.matched).toBe(true);
    expect(result.attempts).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  it('al expirar (timeout) la oferta, ofrece al siguiente candidato', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CENTER);
    await h.hotIndex.seed('d2', ORIGIN.lat, ORIGIN.lon, CENTER);
    // d1 no responde (expira); d2 acepta.
    h.setStrategy((offer) => {
      if (offer.driverId === 'd2') h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED);
    });

    const result = await h.matching.handleTripRequested({ tripId: 't2', origin: ORIGIN });

    expect(result.matched).toBe(true);
    expect(result.driverId).toBe('d2');
    expect(result.attempts).toBe(2);
  });

  it('tras 5 rechazos en radio 1 expande a k-ring radio 2 (neighbors(cell,2))', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 5; i++) await h.hotIndex.seed(`d${i}`, ORIGIN.lat, ORIGIN.lon, CENTER);
    const outer = outerRing2Cell();
    const outerPoint = fromH3(outer);
    await h.hotIndex.seed('d6', outerPoint.lat, outerPoint.lon, outer);

    h.setStrategy((offer) => {
      const outcome = offer.driverId === 'd6' ? DispatchOutcome.ACCEPTED : DispatchOutcome.REJECTED;
      h.matching.respond(offer.matchId, outcome);
    });

    const result = await h.matching.handleTripRequested({ tripId: 't3', origin: ORIGIN });

    expect(result.matched).toBe(true);
    expect(result.driverId).toBe('d6');
    expect(result.attempts).toBe(6);
    expect(h.offered).toContain('d6');
    // d6 solo es alcanzable expandiendo a radio 2.
    expect(h.offered.filter((id) => id !== 'd6')).toHaveLength(5);
  });

  it('si se agotan los candidatos publica dispatch.timeout con el nº de intentos', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CENTER);
    await h.hotIndex.seed('d2', ORIGIN.lat, ORIGIN.lon, CENTER);
    h.setStrategy(() => {}); // nadie responde → todos expiran

    const result = await h.matching.handleTripRequested({ tripId: 't4', origin: ORIGIN });

    expect(result.matched).toBe(false);
    expect(result.attempts).toBe(2);
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.eventType).toBe('dispatch.timeout');
    expect(h.outbox[0]?.envelope.payload.attemptedDrivers).toBe(2);
  });

  it('excluye del pool al conductor en prioridad de pánico (no recibe ofertas)', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CENTER);
    await h.hotIndex.seed('d2', ORIGIN.lat, ORIGIN.lon, CENTER);
    await h.exclusion.exclude('d1');
    h.setStrategy((offer) => h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED));

    const result = await h.matching.handleTripRequested({ tripId: 't5', origin: ORIGIN });

    expect(result.matched).toBe(true);
    expect(result.driverId).toBe('d2');
    expect(h.offered).not.toContain('d1');
  });
});

describe('MatchingService · Ola 2B tier moto-taxi (filtrado por tipo de vehículo)', () => {
  it('un viaje MOTO solo se ofrece a conductores con vehículo MOTO', async () => {
    const h = makeHarness();
    // dCar = CAR (default), dMoto = MOTO.
    await h.hotIndex.seed('dCar', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR);
    await h.hotIndex.seed('dMoto', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.MOTO);
    h.setStrategy((offer) => h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED));

    const result = await h.matching.handleTripRequested({
      tripId: 'tMoto',
      origin: ORIGIN,
      requiredVehicleType: VehicleType.MOTO,
    });

    expect(result.matched).toBe(true);
    expect(result.driverId).toBe('dMoto');
    expect(h.offered).not.toContain('dCar');
  });

  it('un viaje MOTO sin conductores MOTO no encuentra match (timeout)', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('dCar1', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR);
    await h.hotIndex.seed('dCar2', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR);
    h.setStrategy((offer) => h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED));

    const result = await h.matching.handleTripRequested({
      tripId: 'tMoto2',
      origin: ORIGIN,
      requiredVehicleType: VehicleType.MOTO,
    });

    expect(result.matched).toBe(false);
    expect(h.offered).toHaveLength(0);
  });

  it('un viaje CAR (default) no se ofrece a conductores MOTO', async () => {
    const h = makeHarness();
    await h.hotIndex.seed('dMoto', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.MOTO);
    await h.hotIndex.seed('dCar', ORIGIN.lat, ORIGIN.lon, CENTER, VehicleType.CAR);
    h.setStrategy((offer) => h.matching.respond(offer.matchId, DispatchOutcome.ACCEPTED));

    const result = await h.matching.handleTripRequested({ tripId: 'tCar', origin: ORIGIN });

    expect(result.matched).toBe(true);
    expect(result.driverId).toBe('dCar');
    expect(h.offered).not.toContain('dMoto');
  });
});
