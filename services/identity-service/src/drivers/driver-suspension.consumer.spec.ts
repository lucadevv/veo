import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type * as VeoEvents from '@veo/events';
import type { EventEnvelope } from '@veo/events';
import type { Env } from '../config/env.schema';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';

/**
 * Mock de @veo/events: KafkaEventConsumer.on() solo CAPTURA el handler (sin conexión real a Kafka),
 * para poder invocarlo directamente y verificar parsing + delegación + idempotencia. `fleetDriverSuspended`
 * se re-exporta del módulo real (es solo un schema zod puro), así la validación del consumer es la real.
 * `captured` se crea con vi.hoisted porque vi.mock se eleva por encima de los imports.
 */
const captured = vi.hoisted(() => ({
  handler: undefined as ((env: EventEnvelope<unknown>) => Promise<void>) | undefined,
}));

vi.mock('@veo/events', async (importOriginal) => {
  const actual = await importOriginal<typeof VeoEvents>();
  class FakeConsumer {
    on(_eventType: string, handler: (env: EventEnvelope<unknown>) => Promise<void>): this {
      captured.handler = handler;
      return this;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return {
    ...actual,
    createKafka: () => ({}),
    KafkaEventConsumer: FakeConsumer,
  };
});

const config = new ConfigService<Env, true>({ KAFKA_BROKERS: 'localhost:9094' });

function envelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e1',
    eventType: 'fleet.driver.suspended',
    producer: 'fleet-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

const validPayload = {
  driverId: 'd1',
  reason: 'Documento crítico vencido (LICENSE)',
  documentId: 'doc1',
  documentType: 'LICENSE',
  suspendedAt: '2026-06-04T10:00:00.000Z',
};

describe('DriverSuspensionConsumer · fleet.driver.suspended → Driver.suspendedAt', () => {
  beforeEach(() => {
    captured.handler = undefined;
  });

  it('suspende al conductor con el suspendedAt del evento', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    new DriverSuspensionConsumer(drivers as never, config);
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(1);
    expect(drivers.suspendByFleet).toHaveBeenCalledWith(
      'd1',
      new Date('2026-06-04T10:00:00.000Z'),
    );
  });

  it('es idempotente extremo-a-extremo: reentrega del mismo evento (suspendByFleet → false) no rompe', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => false) };
    new DriverSuspensionConsumer(drivers as never, config);
    await captured.handler?.(envelope(validPayload));
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(2);
    expect(drivers.suspendByFleet).toHaveBeenNthCalledWith(2, 'd1', expect.any(Date));
  });

  it('descarta payloads inválidos sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    new DriverSuspensionConsumer(drivers as never, config);
    await captured.handler?.(envelope({ reason: 'sin driverId' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('descarta suspendedAt no parseable sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    new DriverSuspensionConsumer(drivers as never, config);
    await captured.handler?.(envelope({ ...validPayload, suspendedAt: 'no-es-fecha' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('propaga el error para que Kafka reintente (suspendByFleet es idempotente)', async () => {
    const drivers = {
      suspendByFleet: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    new DriverSuspensionConsumer(drivers as never, config);
    await expect(captured.handler?.(envelope(validPayload))).rejects.toThrow('db down');
  });
});
