/**
 * Watchdog de estado — tests del SWEEPER temporal (reglas de negocio críticas, FOUNDATION §7).
 *
 * Cubre el gap del agujero negro: viajes no terminales estancados deben caer a EXPIRED/FAILED.
 *  - REQUESTED/ASSIGNED/REASSIGNING estancados (sin conductor comprometido) → EXPIRED + trip.expired.
 *  - ACCEPTED/ARRIVING/ARRIVED estancados (conductor comprometido) → FAILED + trip.failed (la máquina
 *    NO permite EXPIRED desde post-accept; proponerlo dejaba el viaje estancado para siempre).
 *  - IN_PROGRESS estancado → FAILED + outbox trip.failed.
 *  - CANDADO: todo target que proponga resolveStalledTarget es una transición VÁLIDA de la máquina
 *    real (canTransition) — el watchdog jamás vuelve a proponer una transición prohibida.
 *  - Viaje fresco → intacto (no se transiciona ni se emite evento).
 *  - Viaje ya terminal → ignorado (ni siquiera es candidato; idempotente).
 *
 * Sin Nest DI: TripWatchdogService real sobre un Prisma falso en memoria (estilo trips.service.spec.ts),
 * y el scheduler accionado con un ConfigService falso. El reloj se controla por inyección de `now`.
 */
import { describe, it, expect } from 'vitest';
import { TripStatus, PaymentMethod } from '@veo/shared-types';
import { TripWatchdogService } from './trip-watchdog.service';
import { TripWatchdogRepository } from './trip-watchdog.repository';
import { TripWatchdogScheduler } from './trip-watchdog.scheduler';
import { resolveStalledTarget, WATCHED_STATES, type WatchdogThresholds } from './domain/watchdog';
import { canTransition } from './domain/trip-state-machine';
import { Prisma, type Trip } from '../generated/prisma';

const NOW = new Date('2026-06-04T12:00:00.000Z');

// Umbrales de prueba: REQUESTED 10min, pre-recojo 15min, in-progress 6h.
const THRESHOLDS: WatchdogThresholds = {
  requestedMs: 10 * 60 * 1000,
  prePickupMs: 15 * 60 * 1000,
  inProgressMs: 6 * 60 * 60 * 1000,
};

function buildTrip(overrides: Partial<Trip> = {}): Trip {
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
    // ADR 011 — modo de despacho congelado (default fijo para el fixture base del watchdog).
    dispatchMode: 'FIXED',
    requestedAt: NOW,
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
    paymentMethod: PaymentMethod.YAPE,
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
    negotiationSeq: 1,
    idempotencyKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface CapturedEvent {
  eventType: string;
  payload: { tripId: string; fromStatus: string; staleMinutes: number; passengerId: string };
}

/**
 * Prisma falso en memoria con varios viajes. Soporta lo que usa el watchdog:
 *  - read.trip.findMany (pre-filtro de candidatos: status in WATCHED + updatedAt <= corte).
 *  - read.trip.findUnique (relectura por id en sweepStalledTrip).
 *  - write.trip.updateMany (guard de carrera: where id+status).
 *  - tripEvent.create + outboxEvent.create.
 */
function makePrisma(initial: Trip[]) {
  const store = new Map(initial.map((t) => [t.id, t]));
  const outbox: CapturedEvent[] = [];
  const tripEvents: CapturedEvent[] = [];

  const tx = {
    trip: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: TripStatus };
        data: Partial<Trip>;
      }) => {
        const current = store.get(where.id);
        if (current?.status !== where.status) return { count: 0 };
        store.set(where.id, { ...current, ...data });
        return { count: 1 };
      },
    },
    tripEvent: {
      create: async ({ data }: { data: { eventType: string; payload: unknown } }) => {
        tripEvents.push({
          eventType: data.eventType,
          payload: data.payload as CapturedEvent['payload'],
        });
        return {};
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { eventType: string; envelope: { payload: unknown } } }) => {
        outbox.push({
          eventType: data.eventType,
          payload: data.envelope.payload as CapturedEvent['payload'],
        });
        return {};
      },
    },
  };

  const matchesCandidate = (
    t: Trip,
    where: { status: { in: TripStatus[] }; updatedAt: { lte: Date } },
  ) => where.status.in.includes(t.status) && t.updatedAt.getTime() <= where.updatedAt.lte.getTime();

  const prisma = {
    read: {
      trip: {
        findMany: async ({
          where,
          take,
        }: {
          where: { status: { in: TripStatus[] }; updatedAt: { lte: Date } };
          take: number;
        }) =>
          [...store.values()]
            .filter((t) => matchesCandidate(t, where))
            .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
            .slice(0, take),
        findUnique: async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    _outbox: outbox,
    _tripEvents: tripEvents,
    statusOf: (id: string) => store.get(id)?.status,
  };
  return prisma;
}

// ConfigService falso: devuelve los minutos/horas que producen THRESHOLDS.
const fakeConfig = {
  get: (key: string): number => {
    if (key === 'TRIP_REQUESTED_TIMEOUT_MIN') return 10;
    if (key === 'TRIP_PREPICKUP_TIMEOUT_MIN') return 15;
    if (key === 'TRIP_INPROGRESS_STALE_HOURS') return 6;
    throw new Error(`config inesperada: ${key}`);
  },
};

function mins(n: number): Date {
  return new Date(NOW.getTime() - n * 60 * 1000);
}

// ───────────────────────────── Dominio puro ─────────────────────────────

describe('watchdog · resolveStalledTarget (dominio puro)', () => {
  it('REQUESTED vencido → EXPIRED; fresco → null', () => {
    expect(resolveStalledTarget(TripStatus.REQUESTED, mins(11), NOW, THRESHOLDS)).toBe(
      TripStatus.EXPIRED,
    );
    expect(resolveStalledTarget(TripStatus.REQUESTED, mins(9), NOW, THRESHOLDS)).toBeNull();
  });

  it('ASSIGNED vencido (nadie aceptó) → EXPIRED; fresco → null', () => {
    expect(resolveStalledTarget(TripStatus.ASSIGNED, mins(16), NOW, THRESHOLDS)).toBe(
      TripStatus.EXPIRED,
    );
    expect(resolveStalledTarget(TripStatus.ASSIGNED, mins(14), NOW, THRESHOLDS)).toBeNull();
  });

  it('post-accept (ACCEPTED/ARRIVING/ARRIVED) vencido → FAILED (la máquina no permite EXPIRED ahí)', () => {
    for (const s of [TripStatus.ACCEPTED, TripStatus.ARRIVING, TripStatus.ARRIVED]) {
      expect(resolveStalledTarget(s, mins(16), NOW, THRESHOLDS)).toBe(TripStatus.FAILED);
      expect(resolveStalledTarget(s, mins(14), NOW, THRESHOLDS)).toBeNull();
    }
  });

  it('CANDADO: todo target propuesto es una transición VÁLIDA de la máquina real (canTransition)', () => {
    // El bug original: el watchdog proponía ACCEPTED/ARRIVING/ARRIVED → EXPIRED, que la máquina
    // prohíbe → assertTransition lanzaba en cada barrido y el viaje quedaba estancado PARA SIEMPRE.
    // Este candado recorre TODOS los estados vigilados con antigüedad vencida contra la máquina real.
    for (const s of WATCHED_STATES) {
      const target = resolveStalledTarget(s, mins(9999), NOW, THRESHOLDS);
      expect(target, `estado vigilado ${s} debe vencer a un target`).not.toBeNull();
      if (target === null) continue; // narrowing para TS: el expect de arriba ya falló
      expect(
        canTransition(s, target),
        `watchdog propone ${s} → ${target}, transición PROHIBIDA por la máquina`,
      ).toBe(true);
    }
  });

  it('REASSIGNING vencido (sin ofertas tras re-abrir) → EXPIRED (robustez #4); fresco → null', () => {
    expect(WATCHED_STATES).toContain(TripStatus.REASSIGNING);
    expect(resolveStalledTarget(TripStatus.REASSIGNING, mins(16), NOW, THRESHOLDS)).toBe(
      TripStatus.EXPIRED,
    );
    expect(resolveStalledTarget(TripStatus.REASSIGNING, mins(14), NOW, THRESHOLDS)).toBeNull();
  });

  it('IN_PROGRESS vencido → FAILED; fresco → null', () => {
    expect(resolveStalledTarget(TripStatus.IN_PROGRESS, mins(6 * 60 + 1), NOW, THRESHOLDS)).toBe(
      TripStatus.FAILED,
    );
    expect(resolveStalledTarget(TripStatus.IN_PROGRESS, mins(60), NOW, THRESHOLDS)).toBeNull();
  });

  it('estados terminales / SCHEDULED no se vigilan', () => {
    for (const s of [
      TripStatus.COMPLETED,
      TripStatus.EXPIRED,
      TripStatus.FAILED,
      TripStatus.SCHEDULED,
    ]) {
      expect(WATCHED_STATES).not.toContain(s);
      expect(resolveStalledTarget(s, mins(9999), NOW, THRESHOLDS)).toBeNull();
    }
  });
});

// ───────────────────────────── Sweeper end-to-end (servicio + scheduler) ─────────────────────────────

function makeScheduler(trips: Trip[]) {
  const prisma = makePrisma(trips);
  const svc = new TripWatchdogService(new TripWatchdogRepository(prisma as never));
  const scheduler = new TripWatchdogScheduler(svc, fakeConfig as never);
  return { prisma, svc, scheduler };
}

describe('TripWatchdogScheduler.tick · barrido temporal', () => {
  it('REQUESTED estancado → EXPIRED y encola trip.expired', async () => {
    const trip = buildTrip({ id: 't-req', status: TripStatus.REQUESTED, updatedAt: mins(30) });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-req')).toBe(TripStatus.EXPIRED);
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.expired');
    expect(ev).toBeTruthy();
    expect(ev?.payload.tripId).toBe('t-req');
    expect(ev?.payload.fromStatus).toBe(TripStatus.REQUESTED);
    expect(ev?.payload.staleMinutes).toBe(30);
    expect(prisma._tripEvents.some((e) => e.eventType === 'trip.expired')).toBe(true);
  });

  it('ASSIGNED estancado (nadie aceptó) → EXPIRED y encola trip.expired', async () => {
    const trip = buildTrip({ id: 't-asg', status: TripStatus.ASSIGNED, updatedAt: mins(30) });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-asg')).toBe(TripStatus.EXPIRED);
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.expired');
    expect(ev).toBeTruthy();
    expect(ev?.payload.tripId).toBe('t-asg');
    expect(ev?.payload.fromStatus).toBe(TripStatus.ASSIGNED);
  });

  it('post-accept estancado (ACCEPTED/ARRIVING/ARRIVED) → FAILED y encola trip.failed', async () => {
    // Regresión del bug: antes el watchdog proponía EXPIRED (prohibido desde post-accept) →
    // InvalidTripTransition en cada tick → el viaje quedaba estancado para siempre.
    for (const status of [TripStatus.ACCEPTED, TripStatus.ARRIVING, TripStatus.ARRIVED]) {
      const trip = buildTrip({ id: 't-post', status, driverId: 'drv-1', updatedAt: mins(30) });
      const { prisma, scheduler } = makeScheduler([trip]);

      await scheduler.tick(NOW);

      expect(prisma.statusOf('t-post'), `desde ${status}`).toBe(TripStatus.FAILED);
      const ev = prisma._outbox.find((e) => e.eventType === 'trip.failed');
      expect(ev, `trip.failed desde ${status}`).toBeTruthy();
      expect(ev?.payload.tripId).toBe('t-post');
      expect(ev?.payload.fromStatus).toBe(status);
      expect(prisma._outbox.some((e) => e.eventType === 'trip.expired')).toBe(false);
    }
  });

  it('IN_PROGRESS estancado → FAILED y encola trip.failed', async () => {
    const trip = buildTrip({
      id: 't-prog',
      status: TripStatus.IN_PROGRESS,
      driverId: 'drv-1',
      startedAt: mins(8 * 60),
      updatedAt: mins(8 * 60), // 8h > 6h
    });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-prog')).toBe(TripStatus.FAILED);
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.failed');
    expect(ev).toBeTruthy();
    expect(ev?.payload.tripId).toBe('t-prog');
    expect(ev?.payload.fromStatus).toBe(TripStatus.IN_PROGRESS);
  });

  it('REASSIGNING estancado (re-puja sin ofertas) → EXPIRED y encola trip.expired (robustez #4)', async () => {
    const trip = buildTrip({
      id: 't-reassign',
      status: TripStatus.REASSIGNING,
      updatedAt: mins(20),
    });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-reassign')).toBe(TripStatus.EXPIRED);
    const ev = prisma._outbox.find((e) => e.eventType === 'trip.expired');
    expect(ev).toBeTruthy();
    expect(ev?.payload.tripId).toBe('t-reassign');
    expect(ev?.payload.fromStatus).toBe(TripStatus.REASSIGNING);
  });

  it('viaje fresco no se toca (ni transición ni evento)', async () => {
    const trip = buildTrip({ id: 't-fresh', status: TripStatus.REQUESTED, updatedAt: mins(2) });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-fresh')).toBe(TripStatus.REQUESTED);
    expect(prisma._outbox).toHaveLength(0);
    expect(prisma._tripEvents).toHaveLength(0);
  });

  it('viaje ya terminal se ignora (idempotente, ni candidato)', async () => {
    const trip = buildTrip({ id: 't-done', status: TripStatus.COMPLETED, updatedAt: mins(9999) });
    const { prisma, scheduler } = makeScheduler([trip]);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('t-done')).toBe(TripStatus.COMPLETED);
    expect(prisma._outbox).toHaveLength(0);
  });

  it('barrido mixto: expira sin-aceptación, falla post-accept y en curso, respeta el fresco', async () => {
    const trips = [
      buildTrip({ id: 'a', status: TripStatus.ASSIGNED, driverId: 'd', updatedAt: mins(20) }),
      buildTrip({
        id: 'b',
        status: TripStatus.IN_PROGRESS,
        driverId: 'd',
        updatedAt: mins(7 * 60),
      }),
      buildTrip({ id: 'c', status: TripStatus.ARRIVED, driverId: 'd', updatedAt: mins(5) }), // fresco
      buildTrip({ id: 'e', status: TripStatus.ACCEPTED, driverId: 'd', updatedAt: mins(20) }),
    ];
    const { prisma, scheduler } = makeScheduler(trips);

    await scheduler.tick(NOW);

    expect(prisma.statusOf('a')).toBe(TripStatus.EXPIRED);
    expect(prisma.statusOf('b')).toBe(TripStatus.FAILED);
    expect(prisma.statusOf('c')).toBe(TripStatus.ARRIVED);
    expect(prisma.statusOf('e')).toBe(TripStatus.FAILED);
    expect(prisma._outbox.map((e) => e.eventType).sort()).toEqual([
      'trip.expired',
      'trip.failed',
      'trip.failed',
    ]);
  });
});
