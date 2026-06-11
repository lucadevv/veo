/**
 * HARDENING (incidente dev 2026-06): poison messages se LOGUEAN y SALTAN; errores transitorios
 * SIGUEN reintentando. Un `trip.completed` con `tripId` NO-UUID envenenaba el topic `trip`:
 * dispatch.driverForTrip consultaba una columna `@db.Uuid` → Prisma P2023 → el handler relanzaba →
 * kafkajs reintentaba → crash-loop → partición bloqueada (los viajes nuevos no abrían board).
 *
 * Verifica el comportamiento del handler onTripCompleted SIN Kafka real (espía sobre el
 * KafkaEventConsumer real, con start/stop anulados — los handlers los registra el bootstrap
 * promovido de @veo/events/nest en onModuleInit):
 *  1. tripId no-UUID  → NO relanza (poison: log & skip), NO toca DB.
 *  2. tripId válido   → flujo normal (driverForTrip → projection → releaseDriver).
 *  3. error transitorio (DB caída) → SÍ relanza (reintento de Kafka).
 *  4. error permanente (P2023 desde DB, defensa en profundidad) → NO relanza.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { DriverProjectionService } from '../dispatch/driver-projection.service';

// Captura los handlers que el bootstrap registra con .on() para dispararlos a mano (sin Kafka real).
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

const VALID_TRIP_ID = '018f9a3e-1c2b-7d4e-8a1f-0123456789ab';
const VALID_DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-aaaaaaaaaaaa';

interface Spies {
  driverForTrip: ReturnType<typeof vi.fn>;
  onTripCompleted: ReturnType<typeof vi.fn>;
  releaseDriver: ReturnType<typeof vi.fn>;
}

function build(over: Partial<Spies> = {}): { svc: KafkaConsumersService; spies: Spies } {
  const spies: Spies = {
    driverForTrip: over.driverForTrip ?? vi.fn(async () => VALID_DRIVER_ID),
    onTripCompleted: over.onTripCompleted ?? vi.fn(async () => {}),
    releaseDriver: over.releaseDriver ?? vi.fn(async () => {}),
  };
  const dispatch = {
    driverForTrip: spies.driverForTrip,
    releaseDriver: spies.releaseDriver,
  } as unknown as DispatchService;
  const projection = {
    onTripCompleted: spies.onTripCompleted,
  } as unknown as DriverProjectionService;

  const noop = {} as never;
  const svc = new KafkaConsumersService(
    config,
    dispatch,
    noop, // matching
    { recordDemand: async () => {} } as never, // surge
    projection,
    noop, // offerBoard
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, spies };
}

function fire(_svc: KafkaConsumersService, payload: Record<string, unknown>) {
  const env = createEnvelope({ eventType: 'trip.completed', producer: 'trip-service', payload });
  return handlers.get('trip.completed')?.(env);
}

const completedPayload = (tripId: string): Record<string, unknown> => ({
  tripId,
  fareCents: 1500,
  distanceMeters: 4200,
  durationSeconds: 600,
  driverId: VALID_DRIVER_ID,
});

describe('KafkaConsumersService · trip.completed hardening (poison vs transitorio)', () => {
  it('tripId NO-UUID → NO relanza (log & skip) y NO toca DB', async () => {
    const { svc, spies } = build();
    await svc.onModuleInit();
    // El veneno exacto del incidente: tripId sintético no-UUID.
    await expect(fire(svc, completedPayload('NOT-A-UUID'))).resolves.toBeUndefined();
    expect(spies.driverForTrip).not.toHaveBeenCalled();
    expect(spies.onTripCompleted).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('tripId válido → flujo normal (driverForTrip → projection → releaseDriver)', async () => {
    const { svc, spies } = build();
    await svc.onModuleInit();
    await fire(svc, completedPayload(VALID_TRIP_ID));
    expect(spies.driverForTrip).toHaveBeenCalledWith(VALID_TRIP_ID);
    expect(spies.onTripCompleted).toHaveBeenCalledWith(VALID_DRIVER_ID, expect.any(Date));
    expect(spies.releaseDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('error TRANSITORIO (DB caída) con tripId válido → SÍ relanza (Kafka reintenta)', async () => {
    const transient = Object.assign(new Error('connection refused'), { code: 'P1001' });
    const { svc } = build({
      driverForTrip: vi.fn(async () => {
        throw transient;
      }),
    });
    await svc.onModuleInit();
    await expect(fire(svc, completedPayload(VALID_TRIP_ID))).rejects.toBe(transient);
    await svc.onModuleDestroy();
  });

  it('error PERMANENTE de datos (P2023 desde DB) con tripId válido → NO relanza (defensa en profundidad)', async () => {
    const poison = Object.assign(new Error('inconsistent column data'), { code: 'P2023' });
    const { svc } = build({
      driverForTrip: vi.fn(async () => {
        throw poison;
      }),
    });
    await svc.onModuleInit();
    await expect(fire(svc, completedPayload(VALID_TRIP_ID))).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });
});
