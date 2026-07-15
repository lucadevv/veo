import { describe, it, expect, vi } from 'vitest';
import { ConflictError } from '@veo/utils';
import {
  BookingsRepository,
  type CreateBookingData,
  type OutboxIntent,
} from './bookings.repository';
import type { PrismaService } from '../infra/prisma.service';
import { BookingState } from '../generated/prisma';
import { BookingEventType } from '../events/booking-events';

const BOOKING_ID = '00000000-0000-0000-0000-0000000000b1';

/** Fabrica un P2025 (record not found) que isRecordNotFound reconoce (name + code estructurales de Prisma). */
function p2025(): Error {
  const err = new Error('Record to update not found') as Error & { name: string; code: string };
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2025';
  return err;
}

/**
 * Idempotencia de request del repo (ADR-014 §5.3 + FOUNDATION idempotencia): un doble-POST con la MISMA
 * `dedupKey` (mismo Idempotency-Key) NO crea una segunda fila. El UNIQUE de Postgres tira P2002 en el 2º
 * intento; el repo lo atrapa (isUniqueViolation) y devuelve el Booking ya existente, recuperándolo del
 * PRIMARY (prisma.write) para no perderlo por lag de réplica. Mismo patrón que payment-service `charge`.
 *
 * Se simula el cliente Prisma: `booking.create` tira un P2002 estructural (name =
 * 'PrismaClientKnownRequestError', code = 'P2002') la 2ª vez; la lectura por dedupKey devuelve el original.
 */
const PASSENGER_ID = '00000000-0000-0000-0000-0000000000c1';
// dedupKey scopeada por passengerId (anti-IDOR cross-tenant): `booking:req:{passengerId}:{key}`.
const DEDUP_KEY = `booking:req:${PASSENGER_ID}:00000000-0000-0000-0000-0000000000e1`;

function makeData(): CreateBookingData {
  return {
    id: '00000000-0000-0000-0000-0000000000b1',
    publishedTripId: '00000000-0000-0000-0000-0000000000a1',
    passengerId: '00000000-0000-0000-0000-0000000000c1',
    asientos: 1,
    pickupLat: -12.05,
    pickupLon: -77.04,
    dropoffLat: -13.52,
    dropoffLon: -71.97,
    precioAcordado: 4500,
    mensajeIntro: null,
    specialRequest: null,
    paymentId: null,
    dedupKey: DEDUP_KEY,
    estado: 'PENDIENTE_APROBACION',
  } as unknown as CreateBookingData;
}

const intent: OutboxIntent = {
  eventType: BookingEventType.REQUESTED,
  aggregateId: '00000000-0000-0000-0000-0000000000b1',
  payload: { bookingId: '00000000-0000-0000-0000-0000000000b1' },
};

/** Fabrica un error que isUniqueViolation reconoce como P2002 (name + code estructurales de Prisma). */
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

describe('BookingsRepository · idempotencia de request (doble-POST → 1 fila)', () => {
  it('primer POST crea; segundo POST con la misma dedupKey devuelve el existente (recuperado del PRIMARY)', async () => {
    const created = { ...makeData() };
    let calls = 0;

    // $transaction ejecuta el callback con un `tx` que crea booking + outbox. El 2º intento tira P2002.
    const tx = {
      booking: {
        create: vi.fn(async () => {
          calls += 1;
          if (calls >= 2) throw p2002();
          return created;
        }),
      },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    // FIX 2: la recuperación tras P2002 va al PRIMARY (write), no a la réplica (read). El write acaba de
    // escribir la fila; leerla de la réplica sufriría lag → null → 409 espurio.
    const writeFindUnique = vi.fn(async () => created);
    const readFindUnique = vi.fn(async () => null); // si esto se usara para recuperar, el lag mataría el caso

    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        booking: { findUnique: writeFindUnique },
      },
      read: { booking: { findUnique: readFindUnique } },
    } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);

    const first = await repo.createWithEventIdempotent(DEDUP_KEY, PASSENGER_ID, makeData(), intent);
    const second = await repo.createWithEventIdempotent(
      DEDUP_KEY,
      PASSENGER_ID,
      makeData(),
      intent,
    );

    expect(first).toMatchObject({ id: created.id });
    expect(second).toMatchObject({ id: created.id }); // mismo Booking, no una fila nueva
    expect(tx.booking.create).toHaveBeenCalledTimes(2); // se intentó 2 veces
    expect(writeFindUnique).toHaveBeenCalledWith({ where: { dedupKey: DEDUP_KEY } }); // recuperó del PRIMARY
    expect(readFindUnique).not.toHaveBeenCalled(); // NO se usó la réplica para el read-after-write crítico
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1); // el evento se emitió UNA sola vez
  });

  it('P2002 sin fila ni en el PRIMARY (estado inconsistente) → ConflictError tipado, no un 500 opaco', async () => {
    const tx = {
      booking: {
        create: vi.fn(async () => {
          throw p2002();
        }),
      },
      outboxEvent: { create: vi.fn() },
    };
    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        booking: { findUnique: vi.fn(async () => null) },
      },
      read: { booking: { findUnique: vi.fn(async () => null) } },
    } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    await expect(
      repo.createWithEventIdempotent(DEDUP_KEY, PASSENGER_ID, makeData(), intent),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('ANTI-IDOR CROSS-TENANT (cinturón + tiradores): si la fila recuperada es de OTRO pasajero → ConflictError, NUNCA se devuelve la PII ajena', async () => {
    // Estado que NO debería ocurrir con el namespace por passengerId, pero el chequeo defensivo lo cubre: el
    // insert del pasajero B choca P2002 y la recuperación por dedupKey devuelve una fila cuyo passengerId es de
    // OTRO pasajero (A). La recovery DEBE rechazar (ConflictError) en vez de filtrar la reserva de A.
    const ATTACKER_PASSENGER_B = '00000000-0000-0000-0000-0000000000c2';
    const victimRow = { ...makeData(), passengerId: PASSENGER_ID }; // la fila es de A (PASSENGER_ID)

    const tx = {
      booking: {
        create: vi.fn(async () => {
          throw p2002();
        }),
      },
      outboxEvent: { create: vi.fn() },
    };
    const writeFindUnique = vi.fn(async () => victimRow); // recupera la fila de A
    const prisma = {
      write: {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        booking: { findUnique: writeFindUnique },
      },
      read: { booking: { findUnique: vi.fn(async () => null) } },
    } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    // B reclama la fila; la recovery ve passengerId !== B → ConflictError, no devuelve la reserva de A.
    await expect(
      repo.createWithEventIdempotent(DEDUP_KEY, ATTACKER_PASSENGER_B, makeData(), intent),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

/**
 * F3b — `transitionWithEvent` (approve/reject): la transición de estado + el outbox van en UNA transacción
 * (atomicidad estado↔evento), condicionada por `estado: { in: allowed }` (UPDATE atómico). 0 filas (doble-tap
 * / estado ya cambiado) → P2025 → ConflictError tipado (no un 500). El evento se emite UNA sola vez.
 */
describe('BookingsRepository · transitionWithEvent (outbox-in-transaction, F3b)', () => {
  const intent: OutboxIntent = {
    eventType: BookingEventType.APPROVED,
    aggregateId: BOOKING_ID,
    payload: { bookingId: BOOKING_ID },
  };

  it('transición OK: update + outbox en la MISMA tx, devuelve el booking con el estado nuevo', async () => {
    const updated = { id: BOOKING_ID, estado: BookingState.APROBADO };
    const tx = {
      booking: { update: vi.fn(async () => updated) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      write: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
    } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    const result = await repo.transitionWithEvent(
      BOOKING_ID,
      [BookingState.PENDIENTE_APROBACION],
      { estado: BookingState.APROBADO },
      intent,
    );

    expect(result).toMatchObject({ estado: BookingState.APROBADO });
    // El where es CONDICIONADO por estado (UPDATE atómico): id + estado IN allowed.
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, estado: { in: [BookingState.PENDIENTE_APROBACION] } },
      data: { estado: BookingState.APROBADO },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce(); // evento UNA sola vez (atomicidad)
  });

  it('0 filas (doble-tap / estado ya cambiado) → P2025 → ConflictError tipado, no un 500', async () => {
    const tx = {
      booking: {
        update: vi.fn(async () => {
          throw p2025();
        }),
      },
      outboxEvent: { create: vi.fn() },
    };
    const prisma = {
      write: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
    } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    await expect(
      repo.transitionWithEvent(
        BOOKING_ID,
        [BookingState.PENDIENTE_APROBACION],
        { estado: BookingState.APROBADO },
        intent,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

/**
 * F3b — `markChargePending` (tx2 del charge): APROBADO → COBRO_PENDIENTE + paymentId, condicionado por
 * `estado: APROBADO`. Si ya no está APROBADO (cobro ya registrado) → P2025 → ConflictError (idempotente).
 */
describe('BookingsRepository · markChargePending (tx2 del charge, F3b)', () => {
  const PAYMENT_ID = '00000000-0000-0000-0000-0000000000f1';

  it('APROBADO → COBRO_PENDIENTE + guarda paymentId (where condicionado por APROBADO)', async () => {
    const updated = { id: BOOKING_ID, estado: BookingState.COBRO_PENDIENTE, paymentId: PAYMENT_ID };
    const update = vi.fn(async () => updated);
    const prisma = { write: { booking: { update } } } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    const result = await repo.markChargePending(BOOKING_ID, PAYMENT_ID);

    expect(result).toMatchObject({ estado: BookingState.COBRO_PENDIENTE, paymentId: PAYMENT_ID });
    expect(update).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, estado: BookingState.APROBADO },
      data: { estado: BookingState.COBRO_PENDIENTE, paymentId: PAYMENT_ID },
    });
  });

  it('ya no está APROBADO (cobro ya registrado) → P2025 → ConflictError (idempotente)', async () => {
    const update = vi.fn(async () => {
      throw p2025();
    });
    const prisma = { write: { booking: { update } } } as unknown as PrismaService;

    const repo = new BookingsRepository(prisma);
    await expect(repo.markChargePending(BOOKING_ID, PAYMENT_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
