/**
 * FIX 4 · `trip.cancelled by=DRIVER` (cancelación PRE-accept) cuenta para la ventana de auto-suspensión usando
 * el `driverId` del PAYLOAD ENRIQUECIDO, NO `driverForTrip`.
 *
 * RAÍZ: `trip.cancelled by=DRIVER` es PRE-accept — el conductor está ASSIGNED, NO ACCEPTED. `driverForTrip`
 * busca el match con outcome=ACCEPTED (no existe aún) → devolvería null → la cancelación pre-accept NO se
 * contaría. trip-service ya enriquece el payload con `driverId` (perfil), así que el handler debe contar con
 * `p.driverId` (igual que onReassigning), NO resolverlo vía la réplica.
 *
 * Verifica, SIN Kafka real (espía sobre el KafkaEventConsumer real; handlers registrados por el bootstrap):
 *  1. by=DRIVER con driverId en el payload → registerCancellationInWindow(p.driverId, ...) Y NO llama driverForTrip.
 *  2. by=DRIVER sin driverId (no había conductor) → NO cuenta (guard), NO rompe.
 *  3. by=PASSENGER → NO cuenta (solo el conductor suma a su ventana).
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { DriverProjectionService } from '../dispatch/driver-projection.service';
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
const PAYLOAD_DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-bbbbbbbbbbbb';

interface WindowCall {
  driverId: string;
  tripId: string;
}

function build() {
  const windowCalls: WindowCall[] = [];
  // driverForTrip devuelve null a propósito: PRE-accept NO hay match ACCEPTED. Si el handler lo usara para
  // contar (el bug), la cancelación pre-accept se perdería. El fix NO debe llamarlo para el conteo.
  const driverForTrip = vi.fn(async () => null);
  const dispatch = {
    driverForTrip,
  } as unknown as DispatchService;
  const projection = {
    registerCancellationInWindow: async (driverId: string, tripId: string) => {
      windowCalls.push({ driverId, tripId });
    },
  } as unknown as DriverProjectionService;
  const offerBoard = {
    cancelBoard: async () => {},
  } as unknown as OfferBoardService;
  const matching = {
    cancelSession: async () => {},
  } as unknown as MatchingService;

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
  return { svc, windowCalls, driverForTrip };
}

function cancelledEnvelope(over: { by: 'DRIVER' | 'PASSENGER'; driverId?: string; tripId?: string }) {
  return createEnvelope({
    eventType: 'trip.cancelled',
    producer: 'trip-service',
    payload: {
      tripId: over.tripId ?? VALID_TRIP_ID,
      by: over.by,
      penaltyCents: 0,
      ...(over.driverId !== undefined ? { driverId: over.driverId } : {}),
    },
  });
}

describe('KafkaConsumersService · trip.cancelled count (FIX 4 · driverId del payload, no driverForTrip)', () => {
  it('by=DRIVER con driverId en el payload → cuenta con p.driverId Y NO llama driverForTrip', async () => {
    const { svc, windowCalls, driverForTrip } = build();
    await svc.onModuleInit();

    await handlers.get('trip.cancelled')?.(
      cancelledEnvelope({ by: 'DRIVER', driverId: PAYLOAD_DRIVER_ID }),
    );

    // Contó la cancelación pre-accept con el driverId del PAYLOAD enriquecido (perfil).
    expect(windowCalls).toEqual([{ driverId: PAYLOAD_DRIVER_ID, tripId: VALID_TRIP_ID }]);
    // NO resolvió el driver vía la réplica ACCEPTED (que en pre-accept daría null → perdería el conteo).
    expect(driverForTrip).not.toHaveBeenCalled();

    await svc.onModuleDestroy();
  });

  it('by=DRIVER SIN driverId en el payload (no había conductor) → NO cuenta, NO rompe', async () => {
    const { svc, windowCalls } = build();
    await svc.onModuleInit();

    await expect(
      handlers.get('trip.cancelled')?.(cancelledEnvelope({ by: 'DRIVER' })),
    ).resolves.toBeUndefined();
    expect(windowCalls).toHaveLength(0);

    await svc.onModuleDestroy();
  });

  it('by=PASSENGER → NO cuenta (solo el conductor suma a su ventana de auto-suspensión)', async () => {
    const { svc, windowCalls, driverForTrip } = build();
    await svc.onModuleInit();

    await handlers.get('trip.cancelled')?.(
      cancelledEnvelope({ by: 'PASSENGER', driverId: PAYLOAD_DRIVER_ID }),
    );
    expect(windowCalls).toHaveLength(0);
    expect(driverForTrip).not.toHaveBeenCalled();

    await svc.onModuleDestroy();
  });
});
