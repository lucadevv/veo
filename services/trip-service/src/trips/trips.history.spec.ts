/**
 * TripQueryService.listPassengerTrips — paginación keyset del historial: orden DESC, página + nextCursor
 * (peek), continuación por cursor, y aislamiento por pasajero (solo SUS viajes; anti-IDOR estructural:
 * el `where` SIEMPRE lleva el passengerId, así un viaje ajeno nunca puede colarse).
 */
import { describe, it, expect } from 'vitest';
import { TripQueryService } from './trip-query.service';
import { decodeCursor } from './domain/history';
import type { Trip } from '../generated/prisma';

/** Construye una fila Trip mínima para el historial. */
function trip(
  id: string,
  passengerId: string,
  requestedAt: string,
  over: Partial<Trip> = {},
): Trip {
  return {
    id,
    passengerId,
    driverId: 'drv-1',
    vehicleId: 'veh-1',
    originLat: -12.04,
    originLon: -77.04,
    destLat: -12.12,
    destLon: -77.02,
    waypoints: null,
    scheduledFor: null,
    activatedAt: null,
    vehicleType: 'CAR',
    dispatchMode: 'FIXED',
    requestedAt: new Date(requestedAt),
    assignedAt: null,
    acceptedAt: null,
    arrivingAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: new Date(requestedAt),
    cancelledAt: null,
    passengerClosedAt: null,
    fareCents: 1500,
    agreedFareCents: null,
    currency: 'PEN',
    surgeMultiplier: { toString: () => '1' } as never,
    distanceMeters: 4200,
    durationSeconds: 900,
    paymentMethod: 'CASH',
    status: 'COMPLETED',
    routePolyline: null,
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
    createdAt: new Date(requestedAt),
    updatedAt: new Date(requestedAt),
    ...over,
  };
}

/**
 * Prisma double que MODELA la consulta keyset del historial: filtra por passengerId + el OR del cursor,
 * ordena por (requestedAt DESC, id DESC) y aplica `take`. Así el test verifica el comportamiento real
 * (orden, peek, continuación) sin una DB.
 */
function makePrisma(rows: Trip[]) {
  const findMany = async ({
    where,
    take,
  }: {
    where: { passengerId: string; OR?: Record<string, unknown>[] };
    orderBy: unknown;
    take: number;
  }) => {
    let filtered = rows.filter((r) => r.passengerId === where.passengerId);
    if (where.OR) {
      const ltClause = where.OR[0] as { requestedAt: { lt: Date } };
      const eqClause = where.OR[1] as { requestedAt: Date; id: { lt: string } };
      const cAt = ltClause.requestedAt.lt.getTime();
      const cId = eqClause.id.lt;
      filtered = filtered.filter((r) => {
        const at = r.requestedAt.getTime();
        return at < cAt || (at === cAt && r.id < cId);
      });
    }
    filtered.sort((a, b) => {
      const d = b.requestedAt.getTime() - a.requestedAt.getTime();
      return d !== 0 ? d : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });
    return filtered.slice(0, take);
  };
  return { read: { trip: { findMany } } } as never;
}

/**
 * Igual que makePrisma pero filtrando por `driverId` (espejo del historial del CONDUCTOR): modela el
 * mismo keyset + orden + take, sobre el where que arma driverHistoryWhere.
 */
function makeDriverPrisma(rows: Trip[]) {
  const findMany = async ({
    where,
    take,
  }: {
    where: { driverId: string; OR?: Record<string, unknown>[] };
    orderBy: unknown;
    take: number;
  }) => {
    let filtered = rows.filter((r) => r.driverId === where.driverId);
    if (where.OR) {
      const ltClause = where.OR[0] as { requestedAt: { lt: Date } };
      const eqClause = where.OR[1] as { requestedAt: Date; id: { lt: string } };
      const cAt = ltClause.requestedAt.lt.getTime();
      const cId = eqClause.id.lt;
      filtered = filtered.filter((r) => {
        const at = r.requestedAt.getTime();
        return at < cAt || (at === cAt && r.id < cId);
      });
    }
    filtered.sort((a, b) => {
      const d = b.requestedAt.getTime() - a.requestedAt.getTime();
      return d !== 0 ? d : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });
    return filtered.slice(0, take);
  };
  return { read: { trip: { findMany } } } as never;
}

describe('TripQueryService.listPassengerTrips · historial keyset', () => {
  it('ordena por requestedAt DESC (los más recientes primero)', async () => {
    const rows = [
      trip('a', 'pax-1', '2026-06-01T10:00:00.000Z'),
      trip('b', 'pax-1', '2026-06-03T10:00:00.000Z'),
      trip('c', 'pax-1', '2026-06-02T10:00:00.000Z'),
    ];
    const svc = new TripQueryService(makePrisma(rows));
    const page = await svc.listPassengerTrips('pax-1');
    expect(page.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(page.nextCursor).toBeNull(); // 3 ≤ limit → no hay más
  });

  it('pagina: limit devuelve nextCursor y la 2da página continúa exacto donde terminó', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      trip(`t${i}`, 'pax-1', `2026-06-0${i + 1}T10:00:00.000Z`),
    );
    const svc = new TripQueryService(makePrisma(rows));

    const page1 = await svc.listPassengerTrips('pax-1', undefined, 2);
    expect(page1.items.map((i) => i.id)).toEqual(['t4', 't3']); // 06-05, 06-04
    expect(page1.nextCursor).not.toBeNull();
    // El cursor apunta al ÚLTIMO item devuelto (t3 / 06-04).
    expect(decodeCursor(page1.nextCursor)).toEqual({
      requestedAt: '2026-06-04T10:00:00.000Z',
      id: 't3',
    });

    const page2 = await svc.listPassengerTrips('pax-1', page1.nextCursor!, 2);
    expect(page2.items.map((i) => i.id)).toEqual(['t2', 't1']); // 06-03, 06-02
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await svc.listPassengerTrips('pax-1', page2.nextCursor!, 2);
    expect(page3.items.map((i) => i.id)).toEqual(['t0']); // 06-01, última fila
    expect(page3.nextCursor).toBeNull(); // 1 < limit → fin
  });

  it('solo devuelve los viajes DEL pasajero (anti-IDOR estructural)', async () => {
    const rows = [
      trip('mine-1', 'pax-1', '2026-06-02T10:00:00.000Z'),
      trip('other-1', 'pax-2', '2026-06-03T10:00:00.000Z'),
      trip('mine-2', 'pax-1', '2026-06-01T10:00:00.000Z'),
    ];
    const svc = new TripQueryService(makePrisma(rows));
    const page = await svc.listPassengerTrips('pax-1');
    expect(page.items.map((i) => i.id)).toEqual(['mine-1', 'mine-2']);
    expect(page.items.every((i) => i.id.startsWith('mine'))).toBe(true);
  });

  it('expone los ESTADOS REALES (COMPLETED/CANCELLED/EXPIRED), no todo REQUESTED', async () => {
    const rows = [
      trip('c1', 'pax-1', '2026-06-03T10:00:00.000Z', { status: 'COMPLETED' }),
      trip('x1', 'pax-1', '2026-06-02T10:00:00.000Z', {
        status: 'EXPIRED',
        driverId: null,
        completedAt: null,
      }),
      trip('k1', 'pax-1', '2026-06-01T10:00:00.000Z', {
        status: 'CANCELLED_BY_PASSENGER',
        completedAt: null,
        cancelledAt: new Date('2026-06-01T10:05:00.000Z'),
      }),
    ];
    const svc = new TripQueryService(makePrisma(rows));
    const page = await svc.listPassengerTrips('pax-1');
    expect(page.items.map((i) => i.status)).toEqual([
      'COMPLETED',
      'EXPIRED',
      'CANCELLED_BY_PASSENGER',
    ]);
    expect(page.items[1]!.driverId).toBeNull();
    expect(page.items[2]!.cancelledAt).toBe('2026-06-01T10:05:00.000Z');
  });
});

describe('TripQueryService.listDriverTrips · historial keyset del CONDUCTOR (espejo)', () => {
  it('ordena por requestedAt DESC (los más recientes primero)', async () => {
    const rows = [
      trip('a', 'pax-1', '2026-06-01T10:00:00.000Z', { driverId: 'drv-1' }),
      trip('b', 'pax-2', '2026-06-03T10:00:00.000Z', { driverId: 'drv-1' }),
      trip('c', 'pax-3', '2026-06-02T10:00:00.000Z', { driverId: 'drv-1' }),
    ];
    const svc = new TripQueryService(makeDriverPrisma(rows));
    const page = await svc.listDriverTrips('drv-1');
    expect(page.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(page.nextCursor).toBeNull(); // 3 ≤ limit → no hay más
  });

  it('pagina: limit devuelve nextCursor y la 2da página continúa exacto donde terminó', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      trip(`t${i}`, `pax-${i}`, `2026-06-0${i + 1}T10:00:00.000Z`, { driverId: 'drv-1' }),
    );
    const svc = new TripQueryService(makeDriverPrisma(rows));

    const page1 = await svc.listDriverTrips('drv-1', undefined, 2);
    expect(page1.items.map((i) => i.id)).toEqual(['t4', 't3']); // 06-05, 06-04
    expect(decodeCursor(page1.nextCursor)).toEqual({
      requestedAt: '2026-06-04T10:00:00.000Z',
      id: 't3',
    });

    const page2 = await svc.listDriverTrips('drv-1', page1.nextCursor!, 2);
    expect(page2.items.map((i) => i.id)).toEqual(['t2', 't1']); // 06-03, 06-02

    const page3 = await svc.listDriverTrips('drv-1', page2.nextCursor!, 2);
    expect(page3.items.map((i) => i.id)).toEqual(['t0']); // 06-01, última fila
    expect(page3.nextCursor).toBeNull(); // 1 < limit → fin
  });

  it('solo devuelve los viajes DE ese conductor (anti-IDOR estructural por driverId)', async () => {
    const rows = [
      trip('mine-1', 'pax-1', '2026-06-02T10:00:00.000Z', { driverId: 'drv-1' }),
      trip('other-1', 'pax-1', '2026-06-03T10:00:00.000Z', { driverId: 'drv-OTRO' }),
      trip('mine-2', 'pax-2', '2026-06-01T10:00:00.000Z', { driverId: 'drv-1' }),
    ];
    const svc = new TripQueryService(makeDriverPrisma(rows));
    const page = await svc.listDriverTrips('drv-1');
    expect(page.items.map((i) => i.id)).toEqual(['mine-1', 'mine-2']);
    expect(page.items.every((i) => i.id.startsWith('mine'))).toBe(true);
  });
});
