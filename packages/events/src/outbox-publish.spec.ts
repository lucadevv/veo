/**
 * Tests del cierre del double-publish por TIMEOUT (FIX 4) y de la clasificación poison de publicación (FIX 1)
 * en la capa @veo/events (sin Postgres: el efecto sobre la tabla — failed_at, claim reset — se prueba e2e con
 * Postgres real en payment-service/test/outbox-relay.e2e.spec.ts).
 *
 *  - drainOutbox aplica `publishTimeoutMs` a CADA publish: un publish que se cuelga MÁS que el timeout falla
 *    con OutboxPublishTimeoutError (transitorio) → NO queda vivo cuando su claim vence (cierra el race del stale).
 *  - isPermanentPublishError clasifica un ZodError como PERMANENTE (poison) y un Error genérico como transitorio.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  drainOutbox,
  OutboxPublishTimeoutError,
  type DrainResult,
  type OutboxRecord,
  type OutboxStore,
} from './outbox.js';
import { isPermanentPublishError } from './poison.js';
import type { KafkaEventProducer } from './kafka.js';

/** Store fake: invoca el `publish` que le pasa drainOutbox sobre N records sintéticos y reporta el outcome. */
function fakeStore(recordCount: number): OutboxStore {
  return {
    async drain(_limit, _stale, _concurrency, publish): Promise<DrainResult> {
      const published: string[] = [];
      for (let i = 0; i < recordCount; i++) {
        const record: OutboxRecord = {
          id: `id-${i}`,
          aggregateId: `agg-${i}`,
          envelope: { eventId: `ev-${i}`, eventType: 'x', occurredAt: '', producer: '', schemaVersion: 1, payload: {} },
          createdAt: new Date(),
          publishedAt: null,
        };
        try {
          await publish(record);
          published.push(record.id);
        } catch {
          // El test inspecciona el error directamente vía un producer espiable; acá solo contamos published.
        }
      }
      return { published: published.length, poisoned: [] };
    },
  };
}

describe('drainOutbox · publishTimeoutMs (FIX 4 — cierre del double-publish por stale)', () => {
  it('un publish que excede el timeout RECHAZA con OutboxPublishTimeoutError (transitorio)', async () => {
    vi.useFakeTimers();
    try {
      // Producer cuyo publish NUNCA resuelve (broker colgado) → debe disparar el timeout.
      const hung = new Promise<void>(() => {});
      const producer = { publish: vi.fn(() => hung) } as unknown as KafkaEventProducer;

      const errors: unknown[] = [];
      const store: OutboxStore = {
        async drain(_l, _s, _c, publish): Promise<DrainResult> {
          const rec: OutboxRecord = {
            id: 'id-0',
            aggregateId: 'a',
            envelope: { eventId: 'e', eventType: 'x', occurredAt: '', producer: '', schemaVersion: 1, payload: {} },
            createdAt: new Date(),
            publishedAt: null,
          };
          await publish(rec).catch((err: unknown) => errors.push(err));
          return { published: 0, poisoned: [] };
        },
      };

      const drainPromise = drainOutbox(store, producer, {
        batchSize: 100,
        staleMs: 60_000,
        concurrency: 8,
        publishTimeoutMs: 30_000,
      });
      // Avanzamos el reloj más allá del timeout → el publish colgado se resuelve por timeout.
      await vi.advanceTimersByTimeAsync(30_001);
      await drainPromise;

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(OutboxPublishTimeoutError);
      // El timeout NO es poison permanente → el relay lo trata como transitorio (reset claim → retry).
      expect(isPermanentPublishError(errors[0])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un publish RÁPIDO (dentro del timeout) NO dispara el timeout y publica OK', async () => {
    const producer = { publish: vi.fn(async () => undefined) } as unknown as KafkaEventProducer;
    const result = await drainOutbox(fakeStore(3), producer, {
      batchSize: 100,
      staleMs: 60_000,
      concurrency: 8,
      publishTimeoutMs: 30_000,
    });
    expect(result.published).toBe(3);
    expect(producer.publish).toHaveBeenCalledTimes(3);
  });
});

describe('isPermanentPublishError (FIX 1 — clasificación poison de publicación)', () => {
  it('un ZodError (payload inválido) es PERMANENTE (poison)', () => {
    let zodErr: unknown;
    try {
      z.object({ userId: z.string() }).parse({ userId: 123 });
    } catch (e) {
      zodErr = e;
    }
    expect(zodErr).toBeDefined();
    expect(isPermanentPublishError(zodErr)).toBe(true);
  });

  it('un Error genérico (broker caído/timeout) NO es permanente (transitorio)', () => {
    expect(isPermanentPublishError(new Error('broker down'))).toBe(false);
    expect(isPermanentPublishError(new OutboxPublishTimeoutError(30_000))).toBe(false);
    expect(isPermanentPublishError(null)).toBe(false);
    expect(isPermanentPublishError('ZodError')).toBe(false); // string que MIENTE el name no engaña al guard estructural
  });

  it('reconoce un ZodError ESTRUCTURALMENTE (name + issues[]) — robusto a múltiples copias de zod', () => {
    const fakeZod = { name: 'ZodError', issues: [{ code: 'custom', path: [], message: 'x' }] };
    expect(isPermanentPublishError(fakeZod)).toBe(true);
    expect(isPermanentPublishError({ name: 'ZodError' })).toBe(false); // sin issues[] → no es ZodError
    expect(isPermanentPublishError({ issues: [] })).toBe(false); // sin name → no es ZodError
  });
});
