/**
 * Envelope único de eventos de dominio (FOUNDATION §6).
 * Todo evento que viaja por Kafka usa esta estructura.
 */
import { z } from 'zod';
import { uuidv7 } from '@veo/utils';

export const envelopeSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  occurredAt: z.string().datetime(),
  producer: z.string(),
  traceId: z.string().optional(),
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
  dedupKey?: string;
  schemaVersion: number;
  payload: T;
}

export interface CreateEnvelopeInput<T> {
  eventType: string;
  producer: string;
  payload: T;
  traceId?: string;
  dedupKey?: string;
  schemaVersion?: number;
  occurredAt?: string;
}

export function createEnvelope<T>(input: CreateEnvelopeInput<T>): EventEnvelope<T> {
  return {
    eventId: uuidv7(),
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: input.producer,
    traceId: input.traceId,
    dedupKey: input.dedupKey,
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
  };
}
