import { describe, it, expect, vi } from 'vitest';
import { ConflictError } from '@veo/utils';
import {
  PublishedTripsRepository,
  type CreatePublishedTripData,
  type UpdatePublishedTripData,
  type OutboxIntent,
} from './published-trips.repository';
import type { PrismaService } from '../infra/prisma.service';
import { PublishedTripState } from '../generated/prisma';
import { BookingEventType } from '../events/booking-events';

/**
 * Endurecimiento F1 del write path del PublishedTripsRepository:
 *  - FIX 2 (idempotencia de publish): doble-POST con la MISMA dedupKey → 1 sola oferta (P2002 → recovery del
 *    PRIMARY) + ownership re-verificado (anti-IDOR cross-tenant: fila ajena → ConflictError, no se filtra).
 *  - FIX 1 (UPDATE atómico): el where condicionado por estado que afecta 0 filas (P2025) → ConflictError
 *    tipado, NUNCA un 500 ni el mensaje interno de Prisma.
 */
const DRIVER_ID = '00000000-0000-0000-0000-0000000000d1';
const DEDUP_KEY = `published:req:${DRIVER_ID}:00000000-0000-0000-0000-0000000000e1`;

function makeData(): CreatePublishedTripData {
  return {
    id: '00000000-0000-0000-0000-0000000000t1',
    driverId: DRIVER_ID,
    vehicleId: '00000000-0000-0000-0000-0000000000aa',
    origenLat: -12.05,
    origenLon: -77.04,
    destinoLat: -13.52,
    destinoLon: -71.97,
    fechaHoraSalida: new Date(Date.now() + 86_400_000),
    asientosTotales: 3,
    asientosDisponibles: 3,
    precioBase: 4500,
    modoReserva: 'REVISION_CADA_SOLICITUD',
    dedupKey: DEDUP_KEY,
    estado: PublishedTripState.PUBLICADO,
  } as unknown as CreatePublishedTripData;
}

const intent: OutboxIntent = {
  eventType: BookingEventType.PUBLISHED,
  aggregateId: '00000000-0000-0000-0000-0000000000t1',
  payload: { publishedTripId: '00000000-0000-0000-0000-0000000000t1' },
};

/** Error estructural P2002 (UNIQUE violado) que isUniqueViolation reconoce cross-cliente-generado. */
function p2002(): Error {
  const err = new Error('Unique constraint failed') as Error & {
    name: string;
    code: string;
    meta?: { target?: string[] };
  };
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2002';
  err.meta = { target: ['dedup_key'] };
  return err;
}

/** Error estructural P2025 (record required but not found) que isRecordNotFound reconoce. */
function p2025(): Error {
  const err = new Error('Record to update not found') as Error & { name: string; code: string };
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2025';
  return err;
}

describe('PublishedTripsRepository · idempotencia de publish (FIX 2)', () => {
  it('doble-POST misma dedupKey → 1 oferta (recuperada del PRIMARY), evento emitido 1 vez', async () => {
    const created = { ...makeData(), driverId: DRIVER_ID };
    let calls = 0;
    const tx = {
      publishedTrip: {
        create: vi.fn(async () => {
          calls += 1;
          if (calls >= 2) throw p2002();
          return created;
        }),
      },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const writeFindUnique = vi.fn(async () => created);
    const readFindUnique = vi.fn(async () => null);
    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        publishedTrip: { findUnique: writeFindUnique },
      },
      read: { publishedTrip: { findUnique: readFindUnique } },
    } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    const first = await repo.createWithEventIdempotent(DEDUP_KEY, DRIVER_ID, makeData(), intent);
    const second = await repo.createWithEventIdempotent(DEDUP_KEY, DRIVER_ID, makeData(), intent);

    expect(first).toMatchObject({ id: created.id });
    expect(second).toMatchObject({ id: created.id }); // misma oferta, no una fila nueva
    expect(writeFindUnique).toHaveBeenCalledWith({ where: { dedupKey: DEDUP_KEY } }); // PRIMARY
    expect(readFindUnique).not.toHaveBeenCalled(); // NO réplica en el read-after-write crítico
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1); // evento UNA sola vez
  });

  it('ANTI-CROSS-TENANT: la fila recuperada es de OTRO conductor → ConflictError, NUNCA se devuelve la ajena', async () => {
    const ajena = { ...makeData(), driverId: 'OTRO_DRIVER' };
    const tx = {
      publishedTrip: { create: vi.fn(async () => { throw p2002(); }) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        publishedTrip: { findUnique: vi.fn(async () => ajena) },
      },
      read: { publishedTrip: { findUnique: vi.fn() } },
    } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await expect(
      repo.createWithEventIdempotent(DEDUP_KEY, DRIVER_ID, makeData(), intent),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('P2002 pero ni el PRIMARY tiene la fila (inconsistente) → ConflictError, no un 500 opaco', async () => {
    const tx = {
      publishedTrip: { create: vi.fn(async () => { throw p2002(); }) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        publishedTrip: { findUnique: vi.fn(async () => null) },
      },
      read: { publishedTrip: { findUnique: vi.fn() } },
    } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await expect(
      repo.createWithEventIdempotent(DEDUP_KEY, DRIVER_ID, makeData(), intent),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('PublishedTripsRepository · UPDATE atómico condicionado por estado (FIX 1)', () => {
  const patch: UpdatePublishedTripData = { precioBase: 6000 };
  const updIntent: OutboxIntent = {
    eventType: BookingEventType.UPDATED,
    aggregateId: '00000000-0000-0000-0000-0000000000t1',
    payload: {},
  };

  it('el where matchea (estado válido) → aplica el update + emite el evento en la tx', async () => {
    const updated = { id: 't1', precioBase: 6000 };
    const tx = {
      publishedTrip: { update: vi.fn(async () => updated) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      write: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
    } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    const result = await repo.updateWithEvent(
      't1',
      DRIVER_ID,
      [PublishedTripState.PUBLICADO],
      patch,
      updIntent,
    );

    expect(result).toMatchObject({ id: 't1' });
    // el where lleva id + driverId + estado: { in: [...] } (condicionado por estado, cierra TOCTOU)
    expect(tx.publishedTrip.update).toHaveBeenCalledWith({
      where: { id: 't1', driverId: DRIVER_ID, estado: { in: [PublishedTripState.PUBLICADO] } },
      data: patch,
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('0 filas matchean (estado cambió en la PRIMARIA → P2025) → ConflictError tipado, no 500', async () => {
    const tx = {
      publishedTrip: { update: vi.fn(async () => { throw p2025(); }) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      write: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
    } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await expect(
      repo.updateWithEvent('t1', DRIVER_ID, [PublishedTripState.PUBLICADO], patch, updIntent),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled(); // sin update → sin evento (no duplicado)
  });
});

describe('PublishedTripsRepository · findByDriverId paginado por keyset (FIX 5 + FIX 2)', () => {
  it('sin cursor → take=limit, primera página, ORDEN por id DESC (uuidv7 time-ordered)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.findByDriverId(DRIVER_ID, 20);

    // FIX 2 — keyset consistente: sort y cursor en la MISMA columna (id), no createdAt.
    expect(findMany).toHaveBeenCalledWith({
      where: { driverId: DRIVER_ID },
      orderBy: { id: 'desc' },
      take: 20,
    });
  });

  it('con cursor → keyset (cursor + skip:1) sobre id DESC, sin saltos/duplicados (FIX 2)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.findByDriverId(DRIVER_ID, 5, 't10');

    // El cursor (id) y el orderBy (id DESC) son la MISMA columna → un solo "reloj", keyset consistente.
    expect(findMany).toHaveBeenCalledWith({
      where: { driverId: DRIVER_ID },
      orderBy: { id: 'desc' },
      take: 5,
      cursor: { id: 't10' },
      skip: 1,
    });
  });
});

describe('PublishedTripsRepository · searchByRoute (F2 · geo H3 + keyset)', () => {
  const ORIGIN_RING = ['8928308280fffff', '8928308281fffff'];
  const DEST_RING = ['89283082803ffff', '89283082807ffff'];
  const desde = new Date('2026-07-01T00:00:00.000Z');
  const hasta = new Date('2026-07-02T00:00:00.000Z');
  const ahora = new Date('2026-07-01T08:00:00.000Z');

  it('sin cursor → WHERE: origin_h3 IN ring AND dest_h3 IN ring (A→B), asientos gte, estado in, día+futuro; ORDER fecha ASC, id ASC', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 2,
      estados: [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO],
      desde,
      hasta,
      ahora,
      take: 20,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        originH3: { in: ORIGIN_RING },
        destH3: { in: DEST_RING }, // RUTA A→B: AND con el origen, no OR
        asientosDisponibles: { gte: 2 },
        estado: { in: [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO] },
        fechaHoraSalida: { gte: desde, lt: hasta, gt: ahora },
      },
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take: 20,
    });
  });

  it('con cursor → keyset por tupla (fechaHoraSalida, id) expresado como OR (sin saltos con horas repetidas)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);
    const cursorFecha = new Date('2026-07-01T10:00:00.000Z');

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 1,
      estados: [PublishedTripState.PUBLICADO],
      desde,
      hasta,
      ahora,
      take: 10,
      cursor: { fechaHoraSalida: cursorFecha, id: 't5' },
    });

    // El keyset es la condición OR: fecha > cursor.fecha, O misma fecha con id > cursor.id (orden ASC).
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { fechaHoraSalida: { gt: cursorFecha } },
            { fechaHoraSalida: cursorFecha, id: { gt: 't5' } },
          ],
        }),
      }),
    );
  });
});
