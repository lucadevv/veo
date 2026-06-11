/**
 * PUJA robustez #4 · wiring del consumidor trip.reassigning (regla de negocio crítica).
 *
 * Verifica que al consumir trip.reassigning el consumidor:
 *  1. LIBERA al conductor que canceló (hot-index release vía DispatchService.releaseDriver / markAvailable),
 *     para que vuelva a ser elegible (estaba markBusy desde la aceptación).
 *  2. RECONSTRUYE el board desde el payload enriquecido (no depende de la key vieja de Redis).
 *
 * Sin Kafka real: construimos el consumidor con dobles y accionamos onReassigning vía el handler
 * que el bootstrap promovido (@veo/events/nest) registra en onModuleInit (espía sobre el
 * KafkaEventConsumer real, con start/stop anulados).
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { VehicleType } from '@veo/shared-types';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { OfferBoardService, Reassigning } from '../dispatch/offer-board.service';

// Captura los handlers registrados con .on() para poder dispararlos a mano (sin Kafka real).
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

function build() {
  const released: string[] = [];
  const reopened: Reassigning[] = [];
  const dispatch = {
    releaseDriver: async (driverId: string) => {
      released.push(driverId);
    },
  } as unknown as DispatchService;
  const offerBoard = {
    reopenBoard: async (r: Reassigning) => {
      reopened.push(r);
    },
  } as unknown as OfferBoardService;

  const noop = {} as never;
  const svc = new KafkaConsumersService(
    config,
    dispatch,
    noop, // matching
    { recordDemand: async () => {} } as never, // surge
    noop, // projection
    offerBoard,
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, released, reopened };
}

describe('KafkaConsumersService · trip.reassigning (robustez #4)', () => {
  it('libera al conductor que canceló y reconstruye el board desde el payload enriquecido', async () => {
    const { svc, released, reopened } = build();
    await svc.onModuleInit();

    const env = createEnvelope({
      eventType: 'trip.reassigning',
      producer: 'trip-service',
      payload: {
        tripId: 'trip-1',
        driverId: 'drv-cancel',
        passengerId: 'pax-1',
        vehicleType: VehicleType.CAR,
        origin: { lat: -12.0464, lon: -77.0428 },
        bidCents: 900,
        reason: 'driver_cancelled',
        negotiationSeq: 2,
      },
    });

    await handlers.get('trip.reassigning')?.(env);

    // Liberó al conductor que canceló (vuelve al pool elegible).
    expect(released).toEqual(['drv-cancel']);
    // Reconstruyó el board con los datos del evento (sin depender de la key vieja de Redis).
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      tripId: 'trip-1',
      driverId: 'drv-cancel',
      passengerId: 'pax-1',
      vehicleType: VehicleType.CAR,
      bidCents: 900,
      // H13 — el consumidor propaga el ciclo de negociación del evento al board re-abierto.
      negotiationSeq: 2,
    });

    await svc.onModuleDestroy();
  });
});
