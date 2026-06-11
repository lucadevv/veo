/**
 * Tests de MediaEventConsumer (BR-S01):
 *  - Procesa trip.started / panic.triggered delegando en RecordingService.
 *  - Valida el payload contra el registro central y descarta lo inválido.
 *  - Deduplica por eventId con la marca DESPUÉS del éxito: si el handler falla, el dedup NO se
 *    escribe y el reintento de kafkajs vuelve a procesar (un pánico jamás se pierde).
 *
 * Estilo media: clases construidas directamente con dobles, sin Nest DI. RecordingService va detrás
 * de un doble (su lógica se prueba en recording.service.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MediaEventConsumer } from './media.consumer';
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
  return {
    startForTrip: vi.fn(async () => ({ segmentId: 'seg-1', created: true })),
    finishForTrip: vi.fn(async () => ({ archived: true })),
    onPanic: vi.fn(async () => ({ segmentId: 'seg-1', forced: true })),
  } as unknown as RecordingService;
}

type HandlerFn = (e: EventEnvelope<unknown>) => Promise<void>;

interface ConsumerInternals {
  handle(e: EventEnvelope<unknown>, fn: HandlerFn): Promise<void>;
  onTripStarted: HandlerFn;
  onPanicTriggered: HandlerFn;
}

function makeConsumer(recording: RecordingService) {
  const redis = makeRedis();
  const consumer = new MediaEventConsumer(recording, redis as never, config);
  const c = consumer as unknown as ConsumerInternals;
  return {
    consumer,
    invokePanic: (e: EventEnvelope<unknown>) => c.handle(e, (env) => c.onPanicTriggered(env)),
    invokeStarted: (e: EventEnvelope<unknown>) => c.handle(e, (env) => c.onTripStarted(env)),
  };
}

function panicEnvelope(eventId = 'evt-panic-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'panic.triggered',
    occurredAt: '2026-06-04T00:00:00.000Z',
    producer: 'panic-service',
    schemaVersion: 1,
    payload: {
      panicId: 'panic-1',
      tripId: 'trip-1',
      passengerId: 'pax-1',
      geo: { lat: -12.05, lon: -77.04 },
      dedupKey: 'pax-1:trip-1',
      triggeredAt: '2026-06-04T00:00:00.000Z',
    },
  };
}

describe('MediaEventConsumer', () => {
  it('panic.triggered fuerza la grabación del viaje (delega en RecordingService.onPanic)', async () => {
    const recording = makeRecording();
    const { invokePanic } = makeConsumer(recording);

    await invokePanic(panicEnvelope());

    expect(recording.onPanic).toHaveBeenCalledWith('trip-1', new Date('2026-06-04T00:00:00.000Z'));
  });

  it('trip.started inicia la grabación (delega en RecordingService.startForTrip)', async () => {
    const recording = makeRecording();
    const { invokeStarted } = makeConsumer(recording);

    await invokeStarted({
      eventId: 'evt-start-1',
      eventType: 'trip.started',
      occurredAt: '2026-06-04T00:00:00.000Z',
      producer: 'trip-service',
      schemaVersion: 1,
      payload: { tripId: 'trip-1', driverId: 'drv-1', startedAt: '2026-06-04T00:00:00.000Z' },
    });

    expect(recording.startForTrip).toHaveBeenCalledWith('trip-1', new Date('2026-06-04T00:00:00.000Z'));
  });

  it('ignora payloads inválidos sin procesar nada (no lanza)', async () => {
    const recording = makeRecording();
    const { invokePanic } = makeConsumer(recording);

    await invokePanic({ ...panicEnvelope(), payload: { nope: true } });

    expect(recording.onPanic).not.toHaveBeenCalled();
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a procesar', async () => {
    const recording = makeRecording();
    const { invokePanic } = makeConsumer(recording);
    const evt = panicEnvelope();

    await invokePanic(evt);
    await invokePanic(evt);

    expect(recording.onPanic).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si el handler falla: el reintento de kafkajs vuelve a procesar el pánico', async () => {
    let calls = 0;
    const recording = {
      ...makeRecording(),
      onPanic: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('DB caída');
        return { segmentId: 'seg-1', forced: true };
      }),
    } as unknown as RecordingService;
    const { invokePanic } = makeConsumer(recording);
    const evt = panicEnvelope();

    await expect(invokePanic(evt)).rejects.toThrow('DB caída');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invokePanic(evt);

    expect(calls).toBe(2);
  });
});
