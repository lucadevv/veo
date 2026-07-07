/**
 * WIRING de los consumidores de suspensión: que `driver.suspended` y `driver.reactivated` estén
 * REGISTRADOS en handlers() y enruten al DriverSuspensionService con el driverId del payload. tsc no
 * caza un handler faltante (el mapa es un objeto), por eso este test determinista del cableado.
 */
import { describe, it, expect, vi } from 'vitest';
import { status } from '@grpc/grpc-js';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DriverSuspensionService } from '../dispatch/driver-suspension.service';

/** Error gRPC con su status code crudo, como lo propaga el cliente de @veo/rpc. */
function grpcError(code: number): Error {
  return Object.assign(new Error('gRPC'), { code });
}
const USER_ID = '018f9a3e-1c2b-7d4e-8a1f-cccccccccccc';

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
  onFleetSuspended: ReturnType<typeof vi.fn>;
  onFleetReactivated: ReturnType<typeof vi.fn>;
} {
  const onSuspended = vi.fn(async () => {});
  const onReactivated = vi.fn(async () => {});
  const onFleetSuspended = vi.fn(async () => {});
  const onFleetReactivated = vi.fn(async () => {});
  const suspensionService = {
    onSuspended,
    onReactivated,
    onFleetSuspended,
    onFleetReactivated,
  } as unknown as DriverSuspensionService;
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
  return { svc, onSuspended, onReactivated, onFleetSuspended, onFleetReactivated };
}

describe('KafkaConsumersService · wiring de suspensión', () => {
  it('driver.suspended → DriverSuspensionService.onSuspended(driverId)', async () => {
    const { svc, onSuspended } = build();
    await svc.onModuleInit();
    const env = createEnvelope({
      eventType: 'driver.suspended',
      producer: 'identity-service',
      payload: {
        driverId: DRIVER_ID,
        reason: 'disciplinary',
        suspendedAt: new Date().toISOString(),
      },
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

  it('[eje FLEET · vía DOCUMENTO] fleet.driver_suspended con driverId → onFleetSuspended({driverId})', async () => {
    const { svc, onFleetSuspended } = build();
    await svc.onModuleInit();
    const env = createEnvelope({
      eventType: 'fleet.driver_suspended',
      producer: 'fleet-service',
      payload: {
        driverId: DRIVER_ID,
        reason: 'document_expired',
        documentType: 'SOAT',
        suspendedAt: new Date().toISOString(),
      },
    });
    await handlers.get('fleet.driver_suspended')?.(env);
    expect(onFleetSuspended).toHaveBeenCalledWith({ driverId: DRIVER_ID, userId: undefined });
    await svc.onModuleDestroy();
  });

  it('[eje FLEET · vía ITV] fleet.driver_reactivated con userId → onFleetReactivated({userId})', async () => {
    const { svc, onFleetReactivated } = build();
    await svc.onModuleInit();
    const USER_ID = '018f9a3e-1c2b-7d4e-8a1f-bbbbbbbbbbbb';
    const env = createEnvelope({
      eventType: 'fleet.driver_reactivated',
      producer: 'fleet-service',
      payload: {
        userId: USER_ID,
        reason: 'inspection_renewed',
        reactivatedAt: new Date().toISOString(),
      },
    });
    await handlers.get('fleet.driver_reactivated')?.(env);
    expect(onFleetReactivated).toHaveBeenCalledWith({ driverId: undefined, userId: USER_ID });
    await svc.onModuleDestroy();
  });
});

describe('KafkaConsumersService · poison guard gRPC (head-of-line block)', () => {
  const suspendedEnv = createEnvelope({
    eventType: 'fleet.driver_suspended',
    producer: 'fleet-service',
    payload: {
      userId: USER_ID,
      reason: 'inspection_expired',
      suspendedAt: new Date().toISOString(),
    },
  });

  it('error gRPC PERMANENTE (PERMISSION_DENIED) → SALTA sin relanzar (la partición avanza, no crash-loop)', async () => {
    const { svc, onFleetSuspended } = build();
    await svc.onModuleInit();
    onFleetSuspended.mockRejectedValueOnce(grpcError(status.PERMISSION_DENIED));
    // NO relanza: el handler resuelve → kafkajs commitea el offset → la partición fleet avanza.
    await expect(handlers.get('fleet.driver_suspended')?.(suspendedEnv)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('error gRPC TRANSITORIO (UNAVAILABLE) → RELANZA (kafkajs reintenta cuando identity vuelve)', async () => {
    const { svc, onFleetSuspended } = build();
    await svc.onModuleInit();
    onFleetSuspended.mockRejectedValueOnce(grpcError(status.UNAVAILABLE));
    await expect(handlers.get('fleet.driver_suspended')?.(suspendedEnv)).rejects.toBeDefined();
    await svc.onModuleDestroy();
  });

  it('el guard cubre TAMBIÉN la reactivación fleet (PERMISSION_DENIED → salta)', async () => {
    const { svc, onFleetReactivated } = build();
    await svc.onModuleInit();
    onFleetReactivated.mockRejectedValueOnce(grpcError(status.PERMISSION_DENIED));
    const env = createEnvelope({
      eventType: 'fleet.driver_reactivated',
      producer: 'fleet-service',
      payload: {
        userId: USER_ID,
        reason: 'inspection_renewed',
        reactivatedAt: new Date().toISOString(),
      },
    });
    await expect(handlers.get('fleet.driver_reactivated')?.(env)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });
});
