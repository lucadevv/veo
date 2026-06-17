import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer, type EventEnvelope, type EventHandler } from '@veo/events';
import type { Env } from '../config/env.schema';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';

/**
 * Espía sobre el KafkaEventConsumer REAL (start anulado, sin conexión a Kafka): captura el handler
 * que el bootstrap promovido (@veo/events/nest) registra en onModuleInit, para poder invocarlo
 * directamente y verificar parsing + delegación + idempotencia. La validación zod del consumer
 * (`fleetDriverSuspended`) es la real.
 */
const captured: { handler?: EventHandler } = {};

vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  _eventType: string,
  handler: EventHandler,
) {
  captured.handler = handler;
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

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
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(1);
    expect(drivers.suspendByFleet).toHaveBeenCalledWith('d1', new Date('2026-06-04T10:00:00.000Z'));
  });

  it('es idempotente extremo-a-extremo: reentrega del mismo evento (suspendByFleet → false) no rompe', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => false) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope(validPayload));
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(2);
    expect(drivers.suspendByFleet).toHaveBeenNthCalledWith(2, 'd1', expect.any(Date));
  });

  it('descarta payloads inválidos sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope({ reason: 'sin driverId' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('descarta suspendedAt no parseable sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope({ ...validPayload, suspendedAt: 'no-es-fecha' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('propaga el error para que Kafka reintente (suspendByFleet es idempotente)', async () => {
    const drivers = {
      suspendByFleet: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(captured.handler?.(envelope(validPayload))).rejects.toThrow('db down');
  });
});
