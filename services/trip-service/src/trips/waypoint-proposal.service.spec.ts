/**
 * Lote C (ADR 013 §1.7) — el RE-QUOTE de la parada mid-trip aplica la política de la OFERTA del
 * viaje (multiplier + mínima, la MISMA fórmula que FixedDispatchStrategy vía applyOfferingPricing).
 *
 * Cierra el dominó del Lote B: con la tarifa FIXED firme = max(base×multiplier, minFare), el
 * re-quote viejo (calculateFare base, sin política) producía un delta NEGATIVO en confort/xl
 * (agregar parada BAJABA la tarifa — se regalaba plata) y sobre-cobraba moto ×1/0.55 (tasa auto).
 */
import { describe, it, expect } from 'vitest';
import { TripStatus } from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
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
