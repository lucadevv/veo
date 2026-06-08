/**
 * Re-entrada del cierre post-viaje (TripsService): pending settlement + closeByPassenger.
 * COMPLETED es TERMINAL (no se toca la máquina de estados); passengerClosedAt es un flag de UX.
 * Dobles de prueba sin Nest DI, al estilo de trips.service.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { ConflictError, NotFoundError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import { TripsService } from './trips.service';
import { Prisma, type Trip } from '../generated/prisma';

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const now = new Date('2026-06-06T12:00:00.000Z');
  return {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    vehicleId: 'veh-1',
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
    arrivingAt: now,
    arrivedAt: now,
    startedAt: now,
    completedAt: now,
    cancelledAt: null,
    passengerClosedAt: null,
    fareCents: 1500,
    agreedFareCents: null,
    currency: 'PEN',
    surgeMultiplier: new Prisma.Decimal(1),
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'CASH',
    status: TripStatus.COMPLETED,
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

/**
 * Prisma falso con N viajes en memoria. Soporta findUnique/findFirst (read+write) y update.
 * `findFirst` matchea el where de getPendingSettlement (passengerId + status + passengerClosedAt null)
 * y respeta `orderBy: { completedAt: asc | desc }` (FIFO del pending settlement). Acepta un solo viaje
 * o un array (los tests de cola pasan varios COMPLETED sin cerrar).
 */
interface FindFirstArgs {
  where?: { passengerId?: string; status?: TripStatus; passengerClosedAt?: null | Date };
  orderBy?: { completedAt?: 'asc' | 'desc' };
}

function makePrisma(initial: Trip | Trip[] | null) {
  const store: Trip[] = initial == null ? [] : Array.isArray(initial) ? [...initial] : [initial];
  const matches = (t: Trip, where?: FindFirstArgs['where']): boolean => {
    if (!where) return true;
    if (where.passengerId !== undefined && t.passengerId !== where.passengerId) return false;
    if (where.status !== undefined && t.status !== where.status) return false;
    if (where.passengerClosedAt === null && t.passengerClosedAt !== null) return false;
    return true;
  };
  const findFirst = ({ where, orderBy }: FindFirstArgs): Trip | null => {
    const hits = store.filter((t) => matches(t, where));
    if (hits.length === 0) return null;
    const dir = orderBy?.completedAt === 'desc' ? -1 : 1; // default asc (FIFO)
    if (orderBy?.completedAt) {
      hits.sort((a, b) => {
        const at = a.completedAt ? a.completedAt.getTime() : 0;
        const bt = b.completedAt ? b.completedAt.getTime() : 0;
        return (at - bt) * dir;
      });
    }
    return hits[0] ?? null;
  };
  const upsertById = (id: string, data: Partial<Trip>): Trip => {
    const idx = store.findIndex((t) => t.id === id);
    const base = idx >= 0 ? store[idx] : {};
    const updated = buildTrip({ ...base, ...data, id });
    if (idx >= 0) store[idx] = updated;
    else store.push(updated);
    return updated;
  };
  const prisma = {
    read: {
      trip: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          store.find((t) => t.id === where.id) ?? null,
        findFirst: async (args: FindFirstArgs) => findFirst(args),
      },
    },
    write: {
      trip: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          store.find((t) => t.id === where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Trip> }) =>
          upsertById(where.id, data),
      },
    },
    get _store() {
      return store[0] ?? null;
    },
    get _all() {
      return store;
    },
  };
  return prisma;
}

const maps = {} as never;

describe('TripsService.getPendingSettlement', () => {
  it('devuelve el COMPLETED MÁS VIEJO sin cerrar del pasajero', async () => {
    const prisma = makePrisma(buildTrip());
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.getPendingSettlement('pax-1');
    expect(view?.id).toBe('trip-1');
    expect(view?.status).toBe(TripStatus.COMPLETED);
    expect(view?.passengerClosedAt).toBeNull();
  });

  it('FIFO: con DOS COMPLETED sin cerrar devuelve el MÁS VIEJO (completedAt asc)', async () => {
    // La cola de cierre se drena del más antiguo al más nuevo: la plata de un efectivo viejo no queda
    // enterrada bajo un viaje nuevo. El viejo se completó antes; debe salir primero.
    const viejo = buildTrip({
      id: 'trip-viejo',
      completedAt: new Date('2026-06-06T09:00:00.000Z'),
    });
    const nuevo = buildTrip({
      id: 'trip-nuevo',
      completedAt: new Date('2026-06-06T15:00:00.000Z'),
    });
    const prisma = makePrisma([nuevo, viejo]); // orden de inserción invertido a propósito
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.getPendingSettlement('pax-1');
    expect(view?.id).toBe('trip-viejo');
  });

  it('null si el viaje ya está cerrado (passengerClosedAt seteado)', async () => {
    const prisma = makePrisma(buildTrip({ passengerClosedAt: new Date() }));
    const svc = new TripsService(prisma as never, maps);
    expect(await svc.getPendingSettlement('pax-1')).toBeNull();
  });

  it('null si no hay viaje del pasajero', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    expect(await svc.getPendingSettlement('pax-1')).toBeNull();
  });

  it('null si el COMPLETED es de OTRO pasajero (no se filtra)', async () => {
    const prisma = makePrisma(buildTrip({ passengerId: 'otro' }));
    const svc = new TripsService(prisma as never, maps);
    expect(await svc.getPendingSettlement('pax-1')).toBeNull();
  });
});

describe('TripsService.closeByPassenger', () => {
  it('sella passengerClosedAt sobre el viaje COMPLETED del pasajero', async () => {
    const prisma = makePrisma(buildTrip());
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.closeByPassenger('trip-1', 'pax-1');
    expect(view.passengerClosedAt).not.toBeNull();
    expect(prisma._store?.passengerClosedAt).not.toBeNull();
    // No tocó la máquina de estados: sigue COMPLETED.
    expect(view.status).toBe(TripStatus.COMPLETED);
  });

  it('es IDEMPOTENTE: cerrar dos veces no es error y no re-escribe', async () => {
    const closedAt = new Date('2026-06-06T10:00:00.000Z');
    const prisma = makePrisma(buildTrip({ passengerClosedAt: closedAt }));
    const svc = new TripsService(prisma as never, maps);
    const view = await svc.closeByPassenger('trip-1', 'pax-1');
    expect(view.passengerClosedAt).toBe(closedAt.toISOString());
  });

  it('NotFound (404) si el viaje es de OTRO pasajero (anti-enumeración)', async () => {
    const prisma = makePrisma(buildTrip({ passengerId: 'otro' }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.closeByPassenger('trip-1', 'pax-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('NotFound (404) si el viaje no existe', async () => {
    const prisma = makePrisma(null);
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.closeByPassenger('trip-1', 'pax-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Conflict si el viaje no está COMPLETED (no hay cierre que sellar)', async () => {
    const prisma = makePrisma(buildTrip({ status: TripStatus.IN_PROGRESS }));
    const svc = new TripsService(prisma as never, maps);
    await expect(svc.closeByPassenger('trip-1', 'pax-1')).rejects.toBeInstanceOf(ConflictError);
  });
});
