/**
 * Tests del derecho al olvido (Ley 29733, BR-S06) en payment-service (S7c):
 *  - UserDeletedConsumer anonimiza la PII de pagos + purga la afiliación al recibir user.deleted.
 *  - Valida el payload contra el registro central y deduplica por eventId DESPUÉS del éxito
 *    (processEventOnce de @veo/events).
 *
 * Estilo del repo: clases construidas directamente con dobles, sin Nest DI.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '@veo/events';
import { UserDeletedConsumer } from './user-deleted.consumer';
import type { PaymentsService } from '../payments/payments.service';
import type { AffiliationsService } from '../affiliations/affiliations.service';

const config = {
  getOrThrow: (k: string): string => (k === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
} as never;

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

function envelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'user.deleted',
    occurredAt: '2026-06-10T00:00:00.000Z',
    producer: 'identity-service',
    schemaVersion: 1,
    payload,
  };
}

function makeConsumer(overrides?: { erasePii?: ReturnType<typeof vi.fn> }) {
  const erasePii = overrides?.erasePii ?? vi.fn(async () => ({ paymentsAnonymized: 2 }));
  const eraseAffiliation = vi.fn(async () => ({ erased: true }));
  const payments = { eraseUserPii: erasePii } as unknown as PaymentsService;
  const affiliations = { eraseUser: eraseAffiliation } as unknown as AffiliationsService;
  const consumer = new UserDeletedConsumer(payments, affiliations, makeRedis() as never, config);
  const invoke = (e: EventEnvelope<unknown>) =>
    (consumer as unknown as { onUserDeleted(e: EventEnvelope<unknown>): Promise<void> }).onUserDeleted(e);
  return { erasePii, eraseAffiliation, invoke };
}

describe('UserDeletedConsumer (payment-service · derecho al olvido)', () => {
  it('anonimiza la PII de pagos y purga la afiliación al recibir user.deleted', async () => {
    const { erasePii, eraseAffiliation, invoke } = makeConsumer();

    await invoke(envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }));

    expect(erasePii).toHaveBeenCalledWith('usr-1');
    expect(eraseAffiliation).toHaveBeenCalledWith('usr-1');
  });

  it('ignora payloads inválidos sin purgar nada (no lanza)', async () => {
    const { erasePii, eraseAffiliation, invoke } = makeConsumer();

    await invoke(envelope({ nope: true }));

    expect(erasePii).not.toHaveBeenCalled();
    expect(eraseAffiliation).not.toHaveBeenCalled();
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { erasePii, invoke } = makeConsumer();
    const evt = envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await invoke(evt);
    await invoke(evt);

    expect(erasePii).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    let calls = 0;
    const erasePii = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('DB caída');
      return { paymentsAnonymized: 1 };
    });
    const { invoke } = makeConsumer({ erasePii });
    const evt = envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await expect(invoke(evt)).rejects.toThrow('DB caída');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });
});
