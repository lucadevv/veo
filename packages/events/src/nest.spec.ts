/**
 * Tests del esqueleto promovido de consumers NestJS (Lote P6):
 *  - ErasureConsumerBase: valida payload, deduplica por eventId DESPUÉS del éxito, loguea y
 *    relanza ante fallo (kafkajs reintenta), funciona sin dedup (sobre-escritura determinista).
 *  - KafkaConsumerBootstrap: el registro sale de UN ÚNICO record handlers() (regla de oro:
 *    un groupId = un consumer con TODOS sus eventos) y el log de suscripción se deriva de él.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  ErasureConsumerBase,
  type ErasureDedupConfig,
  type ErasureHandlers,
  type KafkaConsumerBootstrapOptions,
} from './nest.js';
import type { EventEnvelope } from './envelope.js';
import type { DedupRedis } from './dedup.js';

const BOOTSTRAP: KafkaConsumerBootstrapOptions = {
  clientId: 'spec-service',
  brokers: ['localhost:9094'],
  groupId: 'spec-service.erasure',
};

/** Redis en memoria (solo get/set) para deduplicación. */
function makeRedis(): DedupRedis {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, val) => {
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

function tripErasedEnvelope(payload: unknown, eventId = 'evt-2'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'trip.pii_erased',
    occurredAt: '2026-06-10T00:00:00.000Z',
    producer: 'trip-service',
    schemaVersion: 1,
    payload,
  };
}

/** Consumer de prueba: dos eventos del mismo group, con espías inyectados. */
class SpecErasureConsumer extends ErasureConsumerBase {
  constructor(
    private readonly eraseUser: (userId: string) => Promise<string | void>,
    private readonly eraseTrip: (tripId: string) => Promise<string | void>,
    dedup?: ErasureDedupConfig,
  ) {
    super(BOOTSTRAP, dedup);
  }

  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: ({ userId }) => this.eraseUser(userId),
        logError: ({ userId }) => ({ context: { userId }, message: 'fallo user' }),
      },
      'trip.pii_erased': {
        erase: ({ tripId }) => this.eraseTrip(tripId),
        logError: ({ tripId }) => ({ context: { tripId }, message: 'fallo trip' }),
      },
    };
  }

  // Seams (mismo patrón que los servicios): despachan el esqueleto promovido.
  invokeUserDeleted(e: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', e);
  }
  invokeTripErased(e: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('trip.pii_erased', e);
  }
  registeredHandlers(): Readonly<Record<string, unknown>> {
    return this.handlers();
  }
  derivedSubscriptionLog(): string {
    return this.subscriptionLog(Object.keys(this.handlers()));
  }
}

function makeConsumer(withDedup = true) {
  const eraseUser = vi.fn(async (userId: string) => `usuario ${userId} purgado`);
  const eraseTrip = vi.fn(async (_tripId: string) => undefined);
  const dedup = withDedup
    ? { redis: makeRedis(), options: { keyPrefix: 'veo:spec:evt:' } }
    : undefined;
  const consumer = new SpecErasureConsumer(eraseUser, eraseTrip, dedup);
  return { consumer, eraseUser, eraseTrip };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Silencia el Logger de Nest en los tests (y permite asertar sobre él).
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

describe('ErasureConsumerBase · esqueleto', () => {
  it('borra al recibir el evento con payload válido y loguea el mensaje de éxito', async () => {
    const { consumer, eraseUser } = makeConsumer();
    const logSpy = vi.spyOn(Logger.prototype, 'log');

    await consumer.invokeUserDeleted(
      userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }),
    );

    expect(eraseUser).toHaveBeenCalledWith('usr-1');
    expect(logSpy).toHaveBeenCalledWith('usuario usr-1 purgado');
  });

  it('ignora payloads inválidos con warn, sin borrar nada (no lanza)', async () => {
    const { consumer, eraseUser } = makeConsumer();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    await consumer.invokeUserDeleted(userDeletedEnvelope({ nope: true }, 'evt-bad'));

    expect(eraseUser).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'user.deleted con payload inválido (eventId=evt-bad); ignorado',
    );
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a borrar ni loguear', async () => {
    const { consumer, eraseUser } = makeConsumer();
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await consumer.invokeUserDeleted(evt);
    await consumer.invokeUserDeleted(evt);

    expect(eraseUser).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si el borrado falla: loguea estructurado, relanza y el reintento ejecuta', async () => {
    const { consumer, eraseUser } = makeConsumer();
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    eraseUser
      .mockRejectedValueOnce(new Error('Postgres caído'))
      .mockResolvedValueOnce('usuario usr-1 purgado');
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await expect(consumer.invokeUserDeleted(evt)).rejects.toThrow('Postgres caído');
    expect(errorSpy).toHaveBeenCalledWith(
      { err: new Error('Postgres caído'), userId: 'usr-1' },
      'fallo user',
    );
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await consumer.invokeUserDeleted(evt);
    expect(eraseUser).toHaveBeenCalledTimes(2);
  });

  it('eventIds DISTINTOS de eventos distintos comparten el namespace del group sin pisarse', async () => {
    const { consumer, eraseUser, eraseTrip } = makeConsumer();

    await consumer.invokeUserDeleted(
      userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }, 'evt-user'),
    );
    await consumer.invokeTripErased(
      tripErasedEnvelope(
        { tripId: 'trip-1', passengerId: 'usr-1', at: '2026-06-10T00:00:00.000Z' },
        'evt-trip',
      ),
    );

    expect(eraseUser).toHaveBeenCalledTimes(1);
    expect(eraseTrip).toHaveBeenCalledTimes(1);
  });

  it('sin dedup configurado (borrado = sobre-escritura determinista) ejecuta en cada entrega', async () => {
    const { consumer, eraseUser } = makeConsumer(false);
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await consumer.invokeUserDeleted(evt);
    await consumer.invokeUserDeleted(evt);

    expect(eraseUser).toHaveBeenCalledTimes(2);
  });

  it('handler sin mensaje de éxito (void) no loguea éxito', async () => {
    const { consumer, eraseTrip } = makeConsumer();
    const logSpy = vi.spyOn(Logger.prototype, 'log');

    await consumer.invokeTripErased(
      tripErasedEnvelope({ tripId: 'trip-1', passengerId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }),
    );

    expect(eraseTrip).toHaveBeenCalledWith('trip-1');
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('KafkaConsumerBootstrap · regla de oro (un groupId = un consumer, un registro)', () => {
  it('handlers() deriva TODOS los eventos del record de erasure (único punto de registro)', () => {
    const { consumer } = makeConsumer();

    expect(Object.keys(consumer.registeredHandlers())).toEqual(['user.deleted', 'trip.pii_erased']);
  });

  it('el log de suscripción se deriva de los mismos eventos registrados (cero double-source)', () => {
    const { consumer } = makeConsumer();

    expect(consumer.derivedSubscriptionLog()).toBe(
      'Suscrito a user.deleted y trip.pii_erased (derecho al olvido)',
    );
  });
});
