/**
 * B2 (ADR-021 Fase A) — LIBERACIÓN del conductor del pool en TODOS los terminales del viaje.
 *
 * RAÍZ: hasta ADR-021, `onTripCancelled` NO llamaba a `releaseDriver`, y `trip.expired`/`trip.failed` ni
 * siquiera estaban en el consumer → un conductor con match ACCEPTED que veía su viaje cancelado/expirado/
 * fallido quedaba `markBusy` + reclamado (A2) hasta el TTL (2h), fuera del pool. Ahora los TRES terminales
 * resuelven el conductor por `driverForTrip` (match ACCEPTED) y lo liberan vía `dispatch.releaseDriver`
 * (markAvailable + releaseClaim). Fail-safe: sin match ACCEPTED (cancel PRE-accept) → driverForTrip null →
 * no-op. `trip.expired`/`trip.failed` caen en el topic 'trip' ya suscrito → solo hay que registrar el handler.
 *
 * Verifica SIN Kafka real (espía sobre el KafkaEventConsumer real; handlers registrados por el bootstrap):
 *  1. trip.cancelled by=PASSENGER POST-accept → driverForTrip → releaseDriver del conductor asignado.
 *  2. trip.expired → releaseDriver del conductor asignado.
 *  3. trip.failed  → releaseDriver del conductor asignado.
 *  4. fail-safe: driverForTrip null (sin match ACCEPTED) → releaseDriver NO se llama, NO rompe.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { OfferBoardService } from '../dispatch/offer-board.service';
import type { MatchingService } from '../dispatch/matching.service';

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

function build(driverForTripResult: string | null = VALID_DRIVER_ID) {
  const driverForTrip = vi.fn(async () => driverForTripResult);
  const releaseDriver = vi.fn(async () => undefined);
  const dispatch = { driverForTrip, releaseDriver } as unknown as DispatchService;
  const offerBoard = { cancelBoard: async () => {} } as unknown as OfferBoardService;
  const matching = { cancelSession: async () => {} } as unknown as MatchingService;
  const projection = {
    registerCancellationInWindow: async () => {},
  } as never;

  const svc = new KafkaConsumersService(
    config,
    dispatch,
    matching,
    { recordDemand: async () => {} } as never, // surge
    projection,
    {} as never, // suspensionService
    offerBoard,
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, driverForTrip, releaseDriver };
}

const cancelledEnv = () =>
  createEnvelope({
    eventType: 'trip.cancelled',
    producer: 'trip-service',
    payload: { tripId: VALID_TRIP_ID, by: 'PASSENGER', penaltyCents: 0 },
  });

const expiredEnv = () =>
  createEnvelope({
    eventType: 'trip.expired',
    producer: 'trip-service',
    payload: {
      tripId: VALID_TRIP_ID,
      passengerId: 'pax-1',
      fromStatus: 'ASSIGNED',
      staleMinutes: 15,
      at: new Date().toISOString(),
    },
  });

const failedEnv = () =>
  createEnvelope({
    eventType: 'trip.failed',
    producer: 'trip-service',
    payload: {
      tripId: VALID_TRIP_ID,
      passengerId: 'pax-1',
      fromStatus: 'IN_PROGRESS',
      staleMinutes: 360,
      at: new Date().toISOString(),
    },
  });

describe('KafkaConsumersService · B2 release del conductor en los terminales (ADR-021)', () => {
  it('trip.cancelled by=PASSENGER (POST-accept) → libera al conductor asignado', async () => {
    const { svc, driverForTrip, releaseDriver } = build(VALID_DRIVER_ID);
    await svc.onModuleInit();
    await handlers.get('trip.cancelled')?.(cancelledEnv());
    expect(driverForTrip).toHaveBeenCalledWith(VALID_TRIP_ID);
    expect(releaseDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('trip.expired → libera al conductor asignado (watchdog PRE-recojo)', async () => {
    const { svc, driverForTrip, releaseDriver } = build(VALID_DRIVER_ID);
    await svc.onModuleInit();
    // El handler DEBE estar registrado (topic 'trip' ya suscrito).
    expect(handlers.has('trip.expired')).toBe(true);
    await handlers.get('trip.expired')?.(expiredEnv());
    expect(driverForTrip).toHaveBeenCalledWith(VALID_TRIP_ID);
    expect(releaseDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('trip.failed → libera al conductor asignado (watchdog EN-curso)', async () => {
    const { svc, driverForTrip, releaseDriver } = build(VALID_DRIVER_ID);
    await svc.onModuleInit();
    expect(handlers.has('trip.failed')).toBe(true);
    await handlers.get('trip.failed')?.(failedEnv());
    expect(driverForTrip).toHaveBeenCalledWith(VALID_TRIP_ID);
    expect(releaseDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('fail-safe: sin match ACCEPTED (driverForTrip null) → NO libera, NO rompe', async () => {
    const { svc, driverForTrip, releaseDriver } = build(null);
    await svc.onModuleInit();
    await expect(handlers.get('trip.expired')?.(expiredEnv())).resolves.toBeUndefined();
    expect(driverForTrip).toHaveBeenCalledWith(VALID_TRIP_ID);
    expect(releaseDriver).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });
});
