/**
 * WIRING de los consumidores de suspensión: que `driver.suspended` y `driver.reactivated` estén
 * REGISTRADOS en handlers() y enruten al DriverSuspensionService con el driverId del payload. tsc no
 * caza un handler faltante (el mapa es un objeto), por eso este test determinista del cableado.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DriverSuspensionService } from '../dispatch/driver-suspension.service';

const handlers = new Map<string, EventHandler>();
vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  eventType: string,
  handler: EventHandler,
) {
  handlers.set(eventType, handler);
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = {
  getOrThrow: (k: string): string => (k === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
} as never;

const DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-aaaaaaaaaaaa';

function build(): {
  svc: KafkaConsumersService;
  onSuspended: ReturnType<typeof vi.fn>;
  onReactivated: ReturnType<typeof vi.fn>;
} {
  const onSuspended = vi.fn(async () => {});
  const onReactivated = vi.fn(async () => {});
  const suspensionService = { onSuspended, onReactivated } as unknown as DriverSuspensionService;
  const noop = {} as never;
  const svc = new KafkaConsumersService(
    config,
    noop, // dispatch
    noop, // matching
    { recordDemand: async () => {} } as never, // surge
    noop, // projection
    suspensionService,
    noop, // offerBoard
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, onSuspended, onReactivated };
}

describe('KafkaConsumersService · wiring de suspensión', () => {
  it('driver.suspended → DriverSuspensionService.onSuspended(driverId)', async () => {
    const { svc, onSuspended } = build();
    await svc.onModuleInit();
    const env = createEnvelope({
      eventType: 'driver.suspended',
      producer: 'identity-service',
      payload: { driverId: DRIVER_ID, reason: 'disciplinary', suspendedAt: new Date().toISOString() },
    });
    await handlers.get('driver.suspended')?.(env);
    expect(onSuspended).toHaveBeenCalledWith(DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('driver.reactivated → DriverSuspensionService.onReactivated(driverId)', async () => {
    const { svc, onReactivated } = build();
    await svc.onModuleInit();
    const env = createEnvelope({
      eventType: 'driver.reactivated',
      producer: 'identity-service',
      payload: { driverId: DRIVER_ID, reactivatedAt: new Date().toISOString() },
    });
    await handlers.get('driver.reactivated')?.(env);
    expect(onReactivated).toHaveBeenCalledWith(DRIVER_ID);
    await svc.onModuleDestroy();
  });
});
