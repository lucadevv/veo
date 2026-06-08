/**
 * PUJA robustez #4 · wiring del consumidor trip.reassigning (regla de negocio crítica).
 *
 * Verifica que al consumir trip.reassigning el consumidor:
 *  1. LIBERA al conductor que canceló (hot-index release vía DispatchService.releaseDriver / markAvailable),
 *     para que vuelva a ser elegible (estaba markBusy desde la aceptación).
 *  2. RECONSTRUYE el board desde el payload enriquecido (no depende de la key vieja de Redis).
 *
 * Sin Kafka real: construimos el consumidor con dobles y accionamos onReassigning vía el handler
 * registrado en un consumer-fake (mismo idiom .on(eventType, handler) que el KafkaEventConsumer real).
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope } from '@veo/events';
import type * as VeoEvents from '@veo/events';
import { VehicleType } from '@veo/shared-types';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { OfferBoardService, Reassigning } from '../dispatch/offer-board.service';

// Consumer-fake: captura los handlers registrados con .on() para poder dispararlos a mano.
class FakeConsumer {
  readonly handlers = new Map<string, (env: unknown) => Promise<void>>();
  on(eventType: string, handler: (env: unknown) => Promise<void>): this {
    this.handlers.set(eventType, handler);
    return this;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

vi.mock('@veo/events', async (orig) => {
  const actual = await orig<typeof VeoEvents>();
  return {
    ...actual,
    createKafka: () => ({}),
    KafkaEventConsumer: class {
      private readonly fake = new FakeConsumer();
      on(eventType: string, handler: (env: unknown) => Promise<void>) {
        return this.fake.on(eventType, handler);
      }
      async start() {
        return this.fake.start();
      }
      async stop() {
        return this.fake.stop();
      }
      // Atajo de test: dispara el handler registrado.
      fire(eventType: string, env: unknown) {
        return this.fake.handlers.get(eventType)?.(env);
      }
    },
  };
});

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
    // El consumer real expone .fire() en el mock para disparar el handler registrado.
    const consumer = (svc as unknown as { consumer: { fire: (t: string, e: unknown) => Promise<void> } }).consumer;

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

    await consumer.fire('trip.reassigning', env);

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
