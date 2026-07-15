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
      publishedTrip: {
        create: vi.fn(async () => {
          throw p2002();
        }),
      },
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
      publishedTrip: {
        create: vi.fn(async () => {
          throw p2002();
        }),
      },
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
      publishedTrip: {
        update: vi.fn(async () => {
          throw p2025();
        }),
      },
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
      orden: 'salida',
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
      orden: 'salida',
      take: 10,
      cursor: { orden: 'salida', fechaHoraSalida: cursorFecha, id: 't5' },
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

  it('orden=precio → ORDER precioBase ASC, id ASC (el orderBy espeja el campo del keyset)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 1,
      estados: [PublishedTripState.PUBLICADO],
      desde,
      hasta,
      ahora,
      orden: 'precio',
      take: 20,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ precioBase: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('orden=precio con cursor → keyset por tupla (precioBase, id) como OR (sin saltos con precios repetidos)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 1,
      estados: [PublishedTripState.PUBLICADO],
      desde,
      hasta,
      ahora,
      orden: 'precio',
      take: 10,
      cursor: { orden: 'precio', precioBase: 4500, id: 't5' },
    });

    // El "reloj" del keyset ES el campo del orden activo: precio > cursor.precio, O mismo precio con id mayor.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ precioBase: { gt: 4500 } }, { precioBase: 4500, id: { gt: 't5' } }],
        }),
        orderBy: [{ precioBase: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('precioMaxCents → filtro precioBase lte en el WHERE (top-level AND, no colisiona con el keyset del OR)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 1,
      estados: [PublishedTripState.PUBLICADO],
      desde,
      hasta,
      ahora,
      orden: 'precio',
      precioMaxCents: 6000,
      take: 10,
      cursor: { orden: 'precio', precioBase: 4500, id: 't5' },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          precioBase: { lte: 6000 }, // tope top-level (AND)…
          OR: [{ precioBase: { gt: 4500 } }, { precioBase: 4500, id: { gt: 't5' } }], // …keyset aparte en el OR
        }),
      }),
    );
  });

  it('sin precioMaxCents → el WHERE NO trae el tope (contrato previo intacto)', async () => {
    const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.searchByRoute({
      originRing: ORIGIN_RING,
      destRing: DEST_RING,
      asientos: 1,
      estados: [PublishedTripState.PUBLICADO],
      desde,
      hasta,
      ahora,
      orden: 'salida',
      take: 10,
    });

    const arg = findMany.mock.calls[0]![0];
    expect(arg.where).not.toHaveProperty('precioBase');
  });
});

describe('PublishedTripsRepository · browseAll (marketplace BROWSE · sin rings, keyset compartido)', () => {
  const ahora = new Date('2026-07-01T08:00:00.000Z');

  it('BROWSE sin región → WHERE solo estado + salida futura (SIN bbox, SIN ventana de día, SIN asientos): TODO lo futuro', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.browseAll({
      estados: [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO],
      ahora,
      orden: 'salida',
      take: 20,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        estado: { in: [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO] },
        fechaHoraSalida: { gt: ahora }, // solo futuro — sin gte/lt de día (el feed no es un día concreto)
      },
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take: 20,
    });
  });

  it('BROWSE con región → bbox del ORIGEN entra como BETWEEN de lat/lon (bordes inclusive)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);
    const bbox = { minLat: -12.52, maxLat: -11.57, minLon: -77.2, maxLon: -76.7 };

    await repo.browseAll({
      estados: [PublishedTripState.PUBLICADO],
      ahora,
      orden: 'salida',
      bbox,
      take: 20,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          origenLat: { gte: bbox.minLat, lte: bbox.maxLat },
          origenLon: { gte: bbox.minLon, lte: bbox.maxLon },
        }),
      }),
    );
  });

  it('BROWSE con region + destRegion → AMBOS bbox entran al WHERE (origen Y destino, AND independiente)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);
    const bbox = { minLat: -12.52, maxLat: -11.57, minLon: -77.2, maxLon: -76.7 }; // origen: Lima
    const destBbox = { minLat: -15.45, maxLat: -11.1, minLon: -73.98, maxLon: -70.35 }; // destino: Cusco

    await repo.browseAll({
      estados: [PublishedTripState.PUBLICADO],
      ahora,
      orden: 'salida',
      bbox,
      destBbox,
      take: 20,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          origenLat: { gte: bbox.minLat, lte: bbox.maxLat },
          origenLon: { gte: bbox.minLon, lte: bbox.maxLon },
          destinoLat: { gte: destBbox.minLat, lte: destBbox.maxLat },
          destinoLon: { gte: destBbox.minLon, lte: destBbox.maxLon },
        }),
      }),
    );
  });

  it('BROWSE con SOLO destRegion → bbox del DESTINO sin tocar el origen (son independientes)', async () => {
    const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);
    const destBbox = { minLat: -17.3, maxLat: -14.6, minLon: -75.1, maxLon: -70.8 }; // Arequipa

    await repo.browseAll({
      estados: [PublishedTripState.PUBLICADO],
      ahora,
      orden: 'salida',
      destBbox,
      take: 20,
    });

    const arg = findMany.mock.calls[0]![0];
    expect(arg.where).toMatchObject({
      destinoLat: { gte: destBbox.minLat, lte: destBbox.maxLat },
      destinoLon: { gte: destBbox.minLon, lte: destBbox.maxLon },
    });
    expect(arg.where).not.toHaveProperty('origenLat');
    expect(arg.where).not.toHaveProperty('origenLon');
  });

  it('BROWSE orden=precio con cursor → MISMO keyset OR-tupla (precioBase, id) + orderBy espejo que search', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.browseAll({
      estados: [PublishedTripState.PUBLICADO],
      ahora,
      orden: 'precio',
      precioMaxCents: 6000,
      take: 10,
      cursor: { orden: 'precio', precioBase: 4500, id: 't5' },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          precioBase: { lte: 6000 }, // tope top-level (AND)…
          OR: [{ precioBase: { gt: 4500 } }, { precioBase: 4500, id: { gt: 't5' } }], // …keyset en el OR
        }),
        orderBy: [{ precioBase: 'asc' }, { id: 'asc' }],
      }),
    );
  });
});

describe('PublishedTripsRepository · listUpcomingForPopularRoutes (agregado de rutas populares)', () => {
  const ahora = new Date('2026-07-01T08:00:00.000Z');

  it('lee el MISMO universo del browse (SEARCHABLE + salida futura), select mínimo SIN PII, cap por take, salida ASC', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { read: { publishedTrip: { findMany } } } as unknown as PrismaService;
    const repo = new PublishedTripsRepository(prisma);

    await repo.listUpcomingForPopularRoutes(
      [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO],
      ahora,
      500,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        estado: { in: [PublishedTripState.PUBLICADO, PublishedTripState.PARCIALMENTE_RESERVADO] },
        fechaHoraSalida: { gt: ahora },
      },
      // Solo extremos + precio: sin driverId, sin vehicleId, sin H3 (agregado de display, no expone nada).
      select: {
        origenLat: true,
        origenLon: true,
        destinoLat: true,
        destinoLon: true,
        precioBase: true,
      },
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take: 500, // cap honesto de lectura (a mayor volumen → región materializada, no subir el cap)
    });
  });
});
