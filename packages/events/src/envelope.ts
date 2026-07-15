/**
 * Envelope único de eventos de dominio (FOUNDATION §6).
 * Todo evento que viaja por Kafka usa esta estructura.
 */
import { z } from 'zod';
import { uuidv7 } from '@veo/utils';
import { captureTraceparent } from '@veo/observability';

export const envelopeSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  occurredAt: z.string().datetime(),
  producer: z.string(),
  traceId: z.string().optional(),
  // `traceparent`: contexto de traza W3C (`00-{traceId}-{spanId}-{flags}`) capturado en el ENQUEUE
  // (contexto del request) para reconstruirlo en el publish del relay → propagación a través del outbox.
  // OPCIONAL: envelopes viejos (sin el campo) siguen validando y se publican normal (backward-compat).
  traceparent: z.string().optional(),
  dedupKey: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  payload: z.unknown(),
});

export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  producer: string;
  traceId?: string;
  /** Contexto de traza W3C capturado en el enqueue (ver envelopeSchema). Ausente = sin span / OTel off. */
  traceparent?: string;
  dedupKey?: string;
  schemaVersion: number;
  payload: T;
}

export interface CreateEnvelopeInput<T> {
  eventType: string;
  producer: string;
  payload: T;
  traceId?: string;
  /**
   * Override explícito del traceparent W3C. Normalmente NO se pasa: `createEnvelope` lo captura solo del
   * contexto OTel activo (el del request). Útil en tests o si el caller ya tiene el carrier resuelto.
   */
  traceparent?: string;
  dedupKey?: string;
  schemaVersion?: number;
  occurredAt?: string;
}

export function createEnvelope<T>(input: CreateEnvelopeInput<T>): EventEnvelope<T> {
  // CAPTURA en el contexto del request: si hay un span activo, persistimos su traceparent W3C en el
  // envelope para que el relay (que publica DESPUÉS, ya sin el contexto del request) lo restaure y el
  // publish quede linkeado al request original. Sin span / sin OTel → undefined → degrada como hoy.
  const traceparent = input.traceparent ?? captureTraceparent();
  return {
    eventId: uuidv7(),
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: input.producer,
    traceId: input.traceId,
    traceparent,
    dedupKey: input.dedupKey,
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
  };
}
