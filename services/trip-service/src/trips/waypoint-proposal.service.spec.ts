/**
 * Lote C (ADR 013 §1.7) — el RE-QUOTE de la parada mid-trip aplica la política de la OFERTA del
 * viaje (multiplier + mínima, la MISMA fórmula que FixedDispatchStrategy vía applyOfferingPricing).
 *
 * Cierra el dominó del Lote B: con la tarifa FIXED firme = max(base×multiplier, minFare), el
 * re-quote viejo (calculateFare base, sin política) producía un delta NEGATIVO en confort/xl
 * (agregar parada BAJABA la tarifa — se regalaba plata) y sobre-cobraba moto ×1/0.55 (tasa auto).
 */
import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { TripStatus } from '@veo/shared-types';
import { ConflictError, InvalidStateError } from '@veo/utils';
import type { MapsClient } from '@veo/maps';
import type { EnergyCatalogService } from '../pricing/energy-catalog.service';
import type { CatalogService } from '../catalog/catalog.service';
import { WaypointProposalService } from './waypoint-proposal.service';
import { WaypointProposalStatus } from './domain/waypoint-proposal';
import type { PrismaService } from '../infra/prisma.service';
import { Prisma, type Trip, type TripWaypointProposal } from '../generated/prisma';

// ── Dobles de prueba (sin Nest DI), al estilo de trips.service.spec ──

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const now = new Date('2026-06-10T12:00:00.000Z');
  return {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    vehicleId: null,
    originLat: -12.0464,
    originLon: -77.0428,
    destLat: -12.1219,
    destLon: -77.0297,
    waypoints: null,
    scheduledFor: null,
    activatedAt: null,
    vehicleType: 'CAR',
    dispatchMode: 'FIXED',
    requestedAt: now,
    assignedAt: now,
    acceptedAt: now,
    arrivingAt: null,
    arrivedAt: now,
    startedAt: now,
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
    status: TripStatus.IN_PROGRESS,
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
    negotiationSeq: 0,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Prisma falso: un viaje en memoria, sin propuesta PROPOSED previa, captura la propuesta creada. */
function makePrisma(trip: Trip) {
  const createdProposals: TripWaypointProposal[] = [];

  const tx = {
    tripWaypointProposal: {
      create: async ({ data }: { data: Omit<TripWaypointProposal, 'id' | 'respondedAt'> }) => {
        const created = { id: 'wp-1', respondedAt: null, ...data } as TripWaypointProposal;
        createdProposals.push(created);
        return created;
      },
    },
    tripEvent: { create: async () => ({}) },
    outboxEvent: { create: async () => ({}) },
  };

  return {
    read: {
      tripWaypointProposal: { findFirst: async () => null, findUnique: async () => null },
    },
    write: {
      trip: { findUnique: async () => trip },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    _createdProposals: createdProposals,
  };
}

/** Maps falso: devuelve la ruta NUEVA (con la parada) que se le configure. */
function makeMaps(distanceMeters: number, durationSeconds: number): MapsClient {
  return {
    route: async () => ({
      distanceMeters,
      durationSeconds,
      polyline: 'xyz',
      geometry: { type: 'LineString' as const, coordinates: [] },
    }),
  } as unknown as MapsClient;
}

function makeService(trip: Trip, newRoute: { distanceMeters: number; durationSeconds: number }) {
  const prisma = makePrisma(trip);
  const service = new WaypointProposalService(
    prisma as unknown as PrismaService,
    makeMaps(newRoute.distanceMeters, newRoute.durationSeconds),
  );
  return { service, prisma };
}

/** Config con el flip ON (lo único que el re-quote autoritativo lee, además del TTL → default). */
const flipOnConfig = {
  get: (k: string) => (k === 'PRICING_ENERGY_MODEL_ENABLED' ? true : undefined),
} as unknown as ConfigService<Record<string, unknown>, true>;

/** Variante flip-ON: inyecta config + un catálogo de energía que devuelve `price` (o null = sin cargar). */
function makeServiceFlip(
  trip: Trip,
  newRoute: { distanceMeters: number; durationSeconds: number },
  price: number | null,
) {
  const prisma = makePrisma(trip);
  const energyCatalog = {
    getPriceFor: () => Promise.resolve(price),
  } as unknown as EnergyCatalogService;
  const service = new WaypointProposalService(
    prisma as unknown as PrismaService,
    makeMaps(newRoute.distanceMeters, newRoute.durationSeconds),
    flipOnConfig,
    energyCatalog,
  );
  return { service, prisma };
}

describe('proposeWaypoint · F2.1b · re-quote con energía AUTORITATIVA bajo el flip', () => {
  it('FIXED + flip ON: el re-quote SUMA la energía pass-through (más caro que sin flip)', async () => {
    // Confort (×1.25, rendimiento 11), ruta nueva 5.5 km/11 min. Sin flip: 1590×1.25 = 1988.
    // Con flip + gasolina 1100¢/L → energía 100¢/km → +100×5.5 = 550 ⇒ 1987.5+550 = 2537.5 → 2538.
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const { service } = makeServiceFlip(trip, { distanceMeters: 5500, durationSeconds: 660 }, 1100);

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(2538);
    expect(result.newFareCents).toBeGreaterThan(1988); // la energía se sumó (vs sin flip)
  });

  it('FIXED + flip ON + catálogo VACÍO (fuente sin precio) → InvalidStateError (NUNCA cobra de menos)', async () => {
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const { service } = makeServiceFlip(trip, { distanceMeters: 5500, durationSeconds: 660 }, null);

    await expect(
      service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('FIXED + flip OFF: pliega el combustible B3 en el re-quote (espejo del create, no lo descarta)', async () => {
    // Confort (×1.25), ruta nueva 5.5 km/11 min, fuel 40¢/km: 600 + (120+40)·5.5 + 30·11 = 1810 → ×1.25 = 2263.
    // SIN el fix daba 1988 (sin combustible). Floor en trip.fareCents (1875) no domina.
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const prisma = makePrisma(trip);
    const fuel = { getPerKmCents: () => Promise.resolve(40) } as never;
    const service = new WaypointProposalService(
      prisma as unknown as PrismaService,
      makeMaps(5500, 660),
      undefined, // config (flip OFF)
      undefined, // energyCatalog
      fuel, // FuelSurchargeService
    );

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(2263);
  });

  it('PUJA + flip ON: NO suma energía (la puja ignora la energía; mantiene la política vieja)', async () => {
    // PUJA confort: sin energía aunque el flip esté ON → 1590×1.25 = 1988 (igual que sin flip).
    const trip = buildTrip({ category: 'veo_confort', dispatchMode: 'PUJA', fareCents: 1875 });
    const { service } = makeServiceFlip(trip, { distanceMeters: 5500, durationSeconds: 660 }, 1100);

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(1988); // sin el +550 de energía
  });
});

const POINT = { lat: -12.08, lon: -77.03 };

describe('proposeWaypoint · re-quote con la política de la OFERTA (ADR 013 §1.7)', () => {
  it('FIXED confort: el delta es POSITIVO a tasa ×1.25 — agregar parada NUNCA baja la tarifa', async () => {
    // Tarifa vigente FIXED confort (ruta 5 km/10 min): base 1500 × 1.25 = 1875 (Lote B).
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    // Ruta nueva con la parada: 5.5 km/11 min → base 1590. Con el bug viejo (sin política) el
    // re-quote daba 1590 < 1875 → delta −285 (REGALABA plata). Con la política: 1590 × 1.25 =
    // 1987.5 → 1988 → delta +113.
    const { service } = makeService(trip, { distanceMeters: 5500, durationSeconds: 660 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(1988);
    expect(result.deltaFareCents).toBe(113);
    expect(result.deltaFareCents).toBeGreaterThan(0);
  });

  it('FIXED moto: re-cotiza a tasa ×0.55 con su mínima — no sobre-cobra tasa de auto (×1/0.55)', async () => {
    // Tarifa vigente FIXED moto (ruta 4 km/8 min): base 1320 × 0.55 = 726 (mínima 300 no aplica).
    const trip = buildTrip({ category: 'veo_moto', vehicleType: 'MOTO', fareCents: 726 });
    // Ruta nueva: 5 km/10 min → base 1500. Bug viejo: estampaba 1500 (tasa auto, +674 fantasma).
    // Con la política: max(1500 × 0.55, 300) = 825 → delta +99.
    const { service } = makeService(trip, { distanceMeters: 5000, durationSeconds: 600 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(825);
    expect(result.newFareCents).not.toBe(1500); // jamás la base sin política (sobre-cobro moto)
    expect(result.deltaFareCents).toBe(99);
  });

  it('legacy category null + vehicleType MOTO: fallback a veo_moto (misma precedencia que createTrip)', async () => {
    const trip = buildTrip({ category: null, vehicleType: 'MOTO', fareCents: 726 });
    const { service } = makeService(trip, { distanceMeters: 5000, durationSeconds: 600 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    // La política de moto aplica igual sin categoría persistida (viaje pre-catálogo).
    expect(result.newFareCents).toBe(825);
    expect(result.deltaFareCents).toBe(99);
  });

  it('legacy category null + vehicleType CAR: fallback a veo_economico (×1.0 — comportamiento previo intacto)', async () => {
    const trip = buildTrip({ category: null, vehicleType: 'CAR', fareCents: 1320 });
    const { service } = makeService(trip, { distanceMeters: 5000, durationSeconds: 600 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    // Económico ×1.0 sobre la mínima = la base de siempre: los viajes legacy no cambian de precio.
    expect(result.newFareCents).toBe(1500);
    expect(result.deltaFareCents).toBe(180);
  });

  it('PUJA: el re-quote también aplica la política de la oferta (moto no paga tasa auto por la parada)', async () => {
    // Decisión documentada en el service: el re-quote es un quote server-authoritative (no un bid)
    // y el ancla que vio el pasajero (suggestedCents del BFF) ya incluye el multiplier.
    const trip = buildTrip({
      category: 'veo_moto',
      vehicleType: 'MOTO',
      dispatchMode: 'PUJA',
      negotiationSeq: 1,
      fareCents: 700, // tarifa negociada
    });
    const { service } = makeService(trip, { distanceMeters: 5000, durationSeconds: 600 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(825); // max(1500 × 0.55, 300) — no 1500 a tasa auto
    expect(result.deltaFareCents).toBe(125);
  });

  it('PUJA con bid generoso: la tarifa negociada es el PISO — delta 0, nunca negativo (no se regala plata)', async () => {
    const trip = buildTrip({
      category: 'veo_confort',
      dispatchMode: 'PUJA',
      negotiationSeq: 1,
      fareCents: 2500, // negociada por encima del valor de fórmula de la ruta nueva (1988)
    });
    const { service } = makeService(trip, { distanceMeters: 5500, durationSeconds: 660 });

    const result = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(result.newFareCents).toBe(2500); // no baja: agregar una parada NUNCA abarata el viaje
    expect(result.deltaFareCents).toBe(0);
  });

  it('la propuesta persiste el newFareCents con la política aplicada (lo que el conductor acepta es lo que se cobra)', async () => {
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const { service, prisma } = makeService(trip, { distanceMeters: 5500, durationSeconds: 660 });

    await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });

    expect(prisma._createdProposals).toHaveLength(1);
    const [proposal] = prisma._createdProposals;
    expect(proposal?.newFareCents).toBe(1988);
    expect(proposal?.deltaFareCents).toBe(113);
    expect(proposal?.status).toBe(WaypointProposalStatus.PROPOSED);
  });
});

// ── RC4-waypoint · el re-quote usa el pricing EFECTIVO (overlay admin), no el catálogo de código ──

/** CatalogService falso: devuelve un overlay del admin con el pricing que se le pida (enabled). */
function fakeCatalog(pricing: { multiplier: number; minFareCents: number }): CatalogService {
  return {
    resolveOffering: async () => ({ enabled: true, pricing, modePin: undefined }),
  } as unknown as CatalogService;
}

describe('proposeWaypoint · RC4-waypoint · pricing efectivo del overlay del admin', () => {
  it('con overlay (minFare admin ALTO) el re-quote cotiza contra el pricing EFECTIVO, no el de código', async () => {
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const prisma = makePrisma(trip);
    // Overlay del admin: minFare 90000 (muy por encima de la tarifa por ruta y del piso monótono 1875).
    // Sin el fix, waypoint usaba offering.pricing de código (minFare bajo) → newFare ~1988. Con el fix,
    // aplica el minFare del overlay → 90000. La diferencia PRUEBA que se usó el pricing efectivo.
    const service = new WaypointProposalService(
      prisma as unknown as PrismaService,
      makeMaps(5500, 660),
      undefined, // config (flip OFF → rama applyOfferingPricing)
      undefined, // energyCatalog
      undefined, // fuel
      undefined, // baseFare
      fakeCatalog({ multiplier: 1.25, minFareCents: 90000 }),
    );

    const res = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });
    expect(res.newFareCents).toBe(90000); // piso del overlay del admin, no el minFare de código
    expect(res.deltaFareCents).toBe(90000 - 1875);
  });

  it('SIN catálogo inyectado → degradación honesta: cotiza con el pricing de código (comportamiento previo intacto)', async () => {
    const trip = buildTrip({ category: 'veo_confort', fareCents: 1875 });
    const { service } = makeService(trip, { distanceMeters: 5500, durationSeconds: 660 });
    const res = await service.proposeWaypoint(trip.id, { point: POINT, passengerId: 'pax-1' });
    expect(res.newFareCents).toBe(1988); // igual que antes del refactor (pricing de código)
  });
});

// ── RC7-waypoint · el accept guarda la tarifa contra un re-bid concurrente (CAS por fareCents) ──

/** Propuesta PROPOSED viva, cotizada contra `baseFare` (newFareCents − deltaFareCents = baseFare). */
function buildProposal(over: Partial<TripWaypointProposal> = {}): TripWaypointProposal {
  return {
    id: 'wp-1',
    tripId: 'trip-1',
    lat: -12.05,
    lon: -77.04,
    deltaFareCents: 300,
    newFareCents: 1800, // base = 1800 − 300 = 1500
    status: WaypointProposalStatus.PROPOSED,
    proposedAt: new Date('2026-06-10T12:00:00.000Z'),
    expiresAt: new Date('2999-12-31T00:00:00.000Z'), // no vencida
    respondedAt: null,
    ...over,
  } as TripWaypointProposal;
}

/**
 * Fake para el ACCEPT: el `tx.trip.updateMany` HONRA el CAS (status ∈ proposable ∧ fareCents === where.fareCents).
 * `liveTrip` es lo que ve el tx (con el re-bid ya aplicado, si lo hay) → reproduce la carrera propose↔re-bid.
 */
function makeAcceptService(trip: Trip, proposal: TripWaypointProposal, live: Partial<Trip> = {}) {
  const liveTrip = { ...trip, ...live };
  const tx = {
    tripWaypointProposal: { updateMany: async () => ({ count: 1 }) }, // la propuesta sigue PROPOSED
    trip: {
      updateMany: async ({
        where,
      }: {
        where: { status: { in: TripStatus[] }; fareCents?: number };
      }) => {
        const statusOk = where.status.in.includes(liveTrip.status);
        const fareOk = where.fareCents === undefined || where.fareCents === liveTrip.fareCents;
        return { count: statusOk && fareOk ? 1 : 0 };
      },
      findUnique: async () => ({ status: liveTrip.status, fareCents: liveTrip.fareCents }),
    },
    outboxEvent: { create: async () => ({}) },
    tripEvent: { create: async () => ({}) },
  };
  const prisma = {
    read: {
      tripWaypointProposal: { findUnique: async () => proposal, findFirst: async () => null },
    },
    write: {
      trip: { findUnique: async () => trip },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
  const service = new WaypointProposalService(
    prisma as unknown as PrismaService,
    makeMaps(5500, 660),
  );
  return { service };
}

describe('respondWaypoint · accept · RC7 · CAS de tarifa contra re-bid concurrente', () => {
  it('sin re-bid (fareCents intacto) → aceptada, aplica proposal.newFareCents', async () => {
    const trip = buildTrip({ fareCents: 1500 });
    const proposal = buildProposal({ newFareCents: 1800, deltaFareCents: 300 }); // base 1500
    const { service } = makeAcceptService(trip, proposal);

    const res = await service.respondWaypoint(trip.id, proposal.id, { driverId: 'drv-1', accept: true });
    expect(res.status).toBe(WaypointProposalStatus.ACCEPTED);
    expect(res.fareCents).toBe(1800);
  });

  it('re-bid concurrente movió la tarifa (1500→2000) entre propose y accept → 409, NO pisa el re-bid', async () => {
    const trip = buildTrip({ fareCents: 1500 });
    const proposal = buildProposal({ newFareCents: 1800, deltaFareCents: 300 }); // base 1500
    // El tx ve la tarifa YA re-pujada (2000): el CAS `fareCents:1500` no matchea → count 0 → 409 tarifa cambió.
    const { service } = makeAcceptService(trip, proposal, { fareCents: 2000 });

    await expect(
      service.respondWaypoint(trip.id, proposal.id, { driverId: 'drv-1', accept: true }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('el viaje se completó entre propose y accept → 409 (ya no está en curso), no muta la tarifa', async () => {
    const trip = buildTrip({ fareCents: 1500 });
    const proposal = buildProposal({ newFareCents: 1800, deltaFareCents: 300 });
    const { service } = makeAcceptService(trip, proposal, { status: TripStatus.COMPLETED });

    await expect(
      service.respondWaypoint(trip.id, proposal.id, { driverId: 'drv-1', accept: true }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
