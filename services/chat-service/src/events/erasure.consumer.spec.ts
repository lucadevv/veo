/**
 * Tests del derecho al olvido (BR-S06, Ley 29733) en chat-service:
 *  - ChatService.eraseUser borra los mensajes escritos por la identidad borrada (userId y driverId).
 *  - ChatService.eraseTrip purga TODOS los mensajes del viaje (ambos lados).
 *  - ErasureConsumer (ÚNICO consumer del group chat-service.erasure: user.deleted +
 *    trip.pii_erased) borra al recibir cada evento, valida el payload y deduplica.
 *
 * Estilo media: clases construidas directamente con dobles, sin Nest DI.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { ErasureConsumer } from './erasure.consumer';
import type { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';
import type { EventEnvelope } from '@veo/events';

const config = new ConfigService<Env, true>({
  CHAT_MAX_BODY_LENGTH: 2000,
  CHAT_MAX_PAGE_SIZE: 100,
  KAFKA_BROKERS: 'localhost:9094',
} as Partial<Env> as Env);

/** Prisma espía que registra cada deleteMany sobre messages (where + count devuelto). */
function makeSpyPrisma(count = 3): {
  prisma: PrismaService;
  deletes: { where: Record<string, unknown> }[];
} {
  const deletes: { where: Record<string, unknown> }[] = [];
  const deleteMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    deletes.push(args);
    return { count };
  });
  const prisma = { write: { message: { deleteMany } } } as unknown as PrismaService;
  return { prisma, deletes };
}

/** Redis en memoria (solo get/set) para deduplicación. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    },
  };
}

function userDeletedEnvelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'user.deleted',
    occurredAt: '2026-06-10T00:00:00.000Z',
    producer: 'identity-service',
    schemaVersion: 1,
    payload,
  };
}

function tripErasedEnvelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'trip.pii_erased',
    occurredAt: '2026-06-10T00:00:00.000Z',
    producer: 'trip-service',
    schemaVersion: 1,
    payload,
  };
}

interface ErasureConsumerInternals {
  onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
  onTripErased(e: EventEnvelope<unknown>): Promise<void>;
}

function makeConsumer(chat: ChatService) {
  const consumer = new ErasureConsumer(chat, makeRedis() as never, config);
  const internals = consumer as unknown as ErasureConsumerInternals;
  return {
    consumer,
    invokeUserDeleted: (e: EventEnvelope<unknown>) => internals.onUserDeleted(e),
    invokeTripErased: (e: EventEnvelope<unknown>) => internals.onTripErased(e),
  };
}

describe('ChatService.eraseUser (derecho al olvido)', () => {
  it('borra los mensajes cuyo senderId es el usuario borrado', async () => {
    const { prisma, deletes } = makeSpyPrisma(2);
    const svc = new ChatService(prisma, config);

    const res = await svc.eraseUser('usr-1');

    expect(res.deletedMessages).toBe(2);
    expect(deletes[0]?.where).toEqual({ senderId: { in: ['usr-1'] } });
  });

  it('si la identidad era conductor, borra AMBOS lados (userId y driverId)', async () => {
    const { prisma, deletes } = makeSpyPrisma(5);
    const svc = new ChatService(prisma, config);

    await svc.eraseUser('usr-1', 'drv-9');

    expect(deletes[0]?.where).toEqual({ senderId: { in: ['usr-1', 'drv-9'] } });
  });
});

describe('ChatService.eraseTrip (derecho al olvido)', () => {
  it('purga TODOS los mensajes del viaje (ambos participantes)', async () => {
    const { prisma, deletes } = makeSpyPrisma(4);
    const svc = new ChatService(prisma, config);

    const res = await svc.eraseTrip('trip-1');

    expect(res.deletedMessages).toBe(4);
    expect(deletes[0]?.where).toEqual({ tripId: 'trip-1' });
  });
});

describe('ErasureConsumer · user.deleted', () => {
  function setup() {
    const { prisma, deletes } = makeSpyPrisma();
    const chat = new ChatService(prisma, config);
    const eraseSpy = vi.spyOn(chat, 'eraseUser');
    const { invokeUserDeleted: invoke } = makeConsumer(chat);
    return { chat, deletes, eraseSpy, invoke };
  }

  it('borra los mensajes del usuario al recibir user.deleted', async () => {
    const { deletes, invoke } = setup();

    await invoke(userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }));

    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.where).toEqual({ senderId: { in: ['usr-1'] } });
  });

  it('propaga el driverId del payload (mensajes enviados con rol DRIVER)', async () => {
    const { eraseSpy, invoke } = setup();

    await invoke(
      userDeletedEnvelope({ userId: 'usr-1', driverId: 'drv-9', at: '2026-06-10T00:00:00.000Z' }),
    );

    expect(eraseSpy).toHaveBeenCalledWith('usr-1', 'drv-9');
  });

  it('ignora payloads inválidos sin borrar nada (no lanza)', async () => {
    const { deletes, eraseSpy, invoke } = setup();

    await invoke(userDeletedEnvelope({ nope: true }));

    expect(eraseSpy).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(0);
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a borrar', async () => {
    const { eraseSpy, invoke } = setup();
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await invoke(evt);
    await invoke(evt);

    expect(eraseSpy).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si el borrado falla (permite reintento de kafkajs)', async () => {
    const { prisma } = makeSpyPrisma();
    const chat = new ChatService(prisma, config);
    let calls = 0;
    vi.spyOn(chat, 'eraseUser').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('Postgres caído');
      return { deletedMessages: 3 };
    });
    const { invokeUserDeleted: invoke } = makeConsumer(chat);
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await expect(invoke(evt)).rejects.toThrow('Postgres caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });
});

describe('ErasureConsumer · trip.pii_erased', () => {
  function setup() {
    const { prisma, deletes } = makeSpyPrisma(4);
    const chat = new ChatService(prisma, config);
    const eraseSpy = vi.spyOn(chat, 'eraseTrip');
    const { invokeTripErased: invoke } = makeConsumer(chat);
    return { chat, deletes, eraseSpy, invoke };
  }

  it('purga el chat del viaje al recibir trip.pii_erased', async () => {
    const { deletes, invoke } = setup();

    await invoke(
      tripErasedEnvelope({
        tripId: 'trip-1',
        passengerId: 'usr-1',
        at: '2026-06-10T00:00:00.000Z',
      }),
    );

    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.where).toEqual({ tripId: 'trip-1' });
  });

  it('ignora payloads inválidos sin borrar nada (no lanza)', async () => {
    const { deletes, eraseSpy, invoke } = setup();

    await invoke(tripErasedEnvelope({ nope: true }));

    expect(eraseSpy).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(0);
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { eraseSpy, invoke } = setup();
    const evt = tripErasedEnvelope({
      tripId: 'trip-1',
      passengerId: 'usr-1',
      at: '2026-06-10T00:00:00.000Z',
    });

    await invoke(evt);
    await invoke(evt);

    expect(eraseSpy).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    const { prisma } = makeSpyPrisma();
    const chat = new ChatService(prisma, config);
    let calls = 0;
    vi.spyOn(chat, 'eraseTrip').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('Postgres caído');
      return { deletedMessages: 4 };
    });
    const { invokeTripErased: invoke } = makeConsumer(chat);
    const evt = tripErasedEnvelope({
      tripId: 'trip-1',
      passengerId: 'usr-1',
      at: '2026-06-10T00:00:00.000Z',
    });

    await expect(invoke(evt)).rejects.toThrow('Postgres caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });

  it('los DOS eventos comparten el dedup del group: eventIds DISTINTOS no se pisan', async () => {
    const { prisma } = makeSpyPrisma();
    const chat = new ChatService(prisma, config);
    const eraseUserSpy = vi.spyOn(chat, 'eraseUser');
    const eraseTripSpy = vi.spyOn(chat, 'eraseTrip');
    const { invokeUserDeleted, invokeTripErased } = makeConsumer(chat);

    await invokeUserDeleted(
      userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }, 'evt-user'),
    );
    await invokeTripErased(
      tripErasedEnvelope(
        { tripId: 'trip-1', passengerId: 'usr-1', at: '2026-06-10T00:00:00.000Z' },
        'evt-trip',
      ),
    );

    expect(eraseUserSpy).toHaveBeenCalledTimes(1);
    expect(eraseTripSpy).toHaveBeenCalledTimes(1);
  });
});
