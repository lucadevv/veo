/**
 * Tests del derecho al olvido del VIDEO DE CABINA (BR-S06, Ley 29733) en media-service:
 *  - TripErasedConsumer purga el video del viaje al recibir trip.pii_erased.
 *  - Valida el payload, deduplica por eventId y reintenta si la purga falla.
 *
 * Estilo media: clases construidas directamente con dobles, sin Nest DI. RecordingService va detrás
 * de un doble (su lógica de purga se prueba en recording.service.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TripErasedConsumer } from './trip-erased.consumer';
import type { RecordingService } from '../media/recording.service';
import type { Env } from '../config/env.schema';
import type { EventEnvelope } from '@veo/events';

const config = new ConfigService<Env, true>({
  KAFKA_BROKERS: 'localhost:9094',
} as Partial<Env> as Env);

/** Redis en memoria (get/set con EX) para deduplicación. */
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

function makeRecording() {
  const erased: string[] = [];
  const recording = {
    eraseTrip: vi.fn(async (tripId: string) => {
      erased.push(tripId);
      return { purgedSegments: 1 };
    }),
  } as unknown as RecordingService;
  return { recording, erased };
}

function makeConsumer(recording: RecordingService) {
  const redis = makeRedis();
  const consumer = new TripErasedConsumer(recording, redis as never, config);
  const invoke = (e: EventEnvelope<unknown>) =>
    (consumer as unknown as {
      onTripErased(e: EventEnvelope<unknown>): Promise<void>;
    }).onTripErased(e);
  return { consumer, invoke };
}

function envelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'trip.pii_erased',
    occurredAt: '2026-06-04T00:00:00.000Z',
    producer: 'trip-service',
    schemaVersion: 1,
    payload,
  };
}

describe('TripErasedConsumer (derecho al olvido del video)', () => {
  it('purga el video del viaje al recibir trip.pii_erased', async () => {
    const { recording, erased } = makeRecording();
    const { invoke } = makeConsumer(recording);

    await invoke(
      envelope({ tripId: 'trip-1', passengerId: 'pax-1', at: '2026-06-04T00:00:00.000Z' }),
    );

    expect(erased).toEqual(['trip-1']);
  });

  it('ignora payloads inválidos sin purgar nada (no lanza)', async () => {
    const { recording } = makeRecording();
    const { invoke } = makeConsumer(recording);

    await invoke(envelope({ nope: true }));

    expect(recording.eraseTrip).not.toHaveBeenCalled();
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { recording } = makeRecording();
    const { invoke } = makeConsumer(recording);
    const evt = envelope({ tripId: 'trip-1', passengerId: 'pax-1', at: '2026-06-04T00:00:00.000Z' });

    await invoke(evt);
    await invoke(evt);

    expect(recording.eraseTrip).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    const redis = makeRedis();
    let calls = 0;
    const recording = {
      eraseTrip: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('S3 caído');
        return { purgedSegments: 1 };
      }),
    } as unknown as RecordingService;
    const consumer = new TripErasedConsumer(recording, redis as never, config);
    const invoke = (e: EventEnvelope<unknown>) =>
      (consumer as unknown as {
        onTripErased(e: EventEnvelope<unknown>): Promise<void>;
      }).onTripErased(e);
    const evt = envelope({ tripId: 'trip-1', passengerId: 'pax-1', at: '2026-06-04T00:00:00.000Z' });

    await expect(invoke(evt)).rejects.toThrow('S3 caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });
});
