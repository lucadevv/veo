/**
 * Test del enrutado de eventos del consumidor Kafka del driver-bff: valida el payload con
 * EVENT_SCHEMAS, resuelve el conductor destino y empuja a su sala Socket.IO. Cubre el relay de
 * `dispatch.offered` → `dispatch:offer` (GAP 1: la oferta de dispatch llega a la app del conductor).
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '@veo/events';
import { KafkaConsumerService } from './kafka-consumer.service';

interface EmitCall {
  driverId: string;
  event: string;
  payload: unknown;
}

function makeService(grpcDriverId?: string) {
  const emits: EmitCall[] = [];
  const gateway = {
    emitToDriver: (driverId: string, event: string, payload: unknown) =>
      emits.push({ driverId, event, payload }),
  };
  const grpc = {
    call: vi.fn(async () =>
      grpcDriverId ? { found: true, driverId: grpcDriverId } : { found: false },
    ),
  };
  const config = { getOrThrow: () => 'x', get: () => undefined };
  const service = new KafkaConsumerService(config as never, gateway as never, grpc as never);
  const handle = (envelope: EventEnvelope<unknown>, socketEvent: string) =>
    (
      service as unknown as {
        handleEvent: (e: EventEnvelope<unknown>, s: string) => Promise<void>;
      }
    ).handleEvent(envelope, socketEvent);
  return { handle, emits, grpc };
}

function offeredEnvelope(driverId: string): EventEnvelope<unknown> {
  return {
    eventId: 'evt-1',
    eventType: 'dispatch.offered',
    occurredAt: '2026-05-29T00:00:00.000Z',
    producer: 'dispatch-service',
    schemaVersion: 1,
    payload: {
      tripId: 't1',
      driverId,
      matchId: 'm1',
      expiresAt: '2026-05-29T00:00:30.000Z',
    },
  };
}

describe('KafkaConsumerService · relay dispatch.offered → dispatch:offer', () => {
  it('emite dispatch:offer SOLO al conductor de la oferta con el sobre completo', async () => {
    const { handle, emits } = makeService();
    await handle(offeredEnvelope('drv-9'), 'dispatch:offer');

    expect(emits).toHaveLength(1);
    expect(emits[0]).toEqual({
      driverId: 'drv-9',
      event: 'dispatch:offer',
      payload: {
        eventType: 'dispatch.offered',
        occurredAt: '2026-05-29T00:00:00.000Z',
        payload: {
          tripId: 't1',
          driverId: 'drv-9',
          matchId: 'm1',
          expiresAt: '2026-05-29T00:00:30.000Z',
        },
      },
    });
  });

  it('no emite ni consulta gRPC si el payload no cumple el schema', async () => {
    const { handle, emits, grpc } = makeService();
    const bad = offeredEnvelope('drv-9');
    (bad.payload as Record<string, unknown>).expiresAt = undefined;

    await handle(bad, 'dispatch:offer');

    expect(emits).toHaveLength(0);
    expect(grpc.call).not.toHaveBeenCalled();
  });

  it('ignora eventType desconocido sin emitir', async () => {
    const { handle, emits } = makeService();
    await handle(
      { ...offeredEnvelope('drv-9'), eventType: 'dispatch.unknown' },
      'dispatch:offer',
    );
    expect(emits).toHaveLength(0);
  });
});
