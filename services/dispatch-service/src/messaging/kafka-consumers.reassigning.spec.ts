/**
 * PUJA robustez #4 · wiring del consumidor trip.reassigning (regla de negocio crítica).
 *
 * Verifica que al consumir trip.reassigning el consumidor:
 *  1. LIBERA al conductor que canceló (hot-index release vía DispatchService.releaseDriver / markAvailable),
 *     para que vuelva a ser elegible (estaba markBusy desde la aceptación).
 *  2. RECONSTRUYE el board desde el payload enriquecido (no depende de la key vieja de Redis).
 *  3. CUENTA la cancelación POST-accept (la abusiva) en la MISMA ventana rolling de auto-suspensión,
 *     reusando registerCancellationInWindow (driverId de perfil, tripId, occurredAt del envelope).
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
import type { DriverProjectionService } from '../dispatch/driver-projection.service';

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

interface WindowCall {
  driverId: string;
  tripId: string;
  occurredAt: Date;
}

function build(opts?: { countThrows?: Error }) {
  const released: string[] = [];
  const reopened: Reassigning[] = [];
  const windowCalls: WindowCall[] = [];
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
  // Doble de la proyección: captura cada registro en la ventana rolling de cancelaciones (el conteo/poda/
  // emisión real se prueban en driver-projection.cancellation-window.spec.ts; acá solo verificamos el WIRING
  // del handler de reassigning → registerCancellationInWindow con driverId de perfil, tripId y occurredAt).
  // `countThrows`: simula un hipo TRANSITORIO del contador (analítica) para probar que NO bloquea el reopen.
  const projection = {
    registerCancellationInWindow: async (driverId: string, tripId: string, occurredAt: Date) => {
      windowCalls.push({ driverId, tripId, occurredAt });
      if (opts?.countThrows) throw opts.countThrows;
    },
  } as unknown as DriverProjectionService;

  const noop = {} as never;
  const svc = new KafkaConsumersService(
    config,
    dispatch,
    noop, // matching
    { recordDemand: async () => {} } as never, // surge
    projection,
    offerBoard,
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, released, reopened, windowCalls };
}

const VALID_TRIP_ID = '22222222-2222-2222-2222-222222222222';
const CANCEL_DRIVER_ID = '33333333-3333-3333-3333-333333333333';

function reassigningEnvelope(overrides?: { tripId?: string; driverId?: string }) {
  return createEnvelope({
    eventType: 'trip.reassigning',
    producer: 'trip-service',
    payload: {
      tripId: overrides?.tripId ?? VALID_TRIP_ID,
      driverId: overrides?.driverId ?? CANCEL_DRIVER_ID,
      passengerId: 'pax-1',
      vehicleType: VehicleType.CAR,
      origin: { lat: -12.0464, lon: -77.0428 },
      bidCents: 900,
      reason: 'driver_cancelled' as const,
      negotiationSeq: 2,
    },
  });
}

describe('KafkaConsumersService · trip.reassigning (robustez #4)', () => {
  it('libera al conductor que canceló y reconstruye el board desde el payload enriquecido', async () => {
    const { svc, released, reopened } = build();
    await svc.onModuleInit();

    const env = reassigningEnvelope({ tripId: 'trip-1', driverId: 'drv-cancel' });

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

  it('CUENTA la cancelación POST-accept en la ventana rolling Y mantiene intacto el reopen del board', async () => {
    const { svc, reopened, windowCalls } = build();
    await svc.onModuleInit();

    const env = reassigningEnvelope();
    await handlers.get('trip.reassigning')?.(env);

    // El conductor abusivo (aceptó y abandonó) SÍ suma a la ventana de auto-suspensión, con su id de PERFIL,
    // el tripId y el occurredAt REAL del hecho (del envelope, no el de consumo).
    expect(windowCalls).toHaveLength(1);
    expect(windowCalls[0]).toMatchObject({
      driverId: CANCEL_DRIVER_ID,
      tripId: VALID_TRIP_ID,
    });
    expect(windowCalls[0]!.occurredAt.toISOString()).toBe(env.occurredAt);
    // El conteo NO rompe el reopen del board: el pasajero abandonado sigue recibiendo un board re-abierto.
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ tripId: VALID_TRIP_ID, driverId: CANCEL_DRIVER_ID });

    await svc.onModuleDestroy();
  });

  it('FIX 3 · el reopen del board OCURRE aunque el conteo falle transitorio (seguridad primero, no gateada por analítica)', async () => {
    // El contador (analítica) tira un error TRANSITORIO. El reopen del board es la acción de SEGURIDAD (re-abre
    // el board para que el pasajero abandonado consiga otro conductor) → NO debe quedar gateado por el hipo del
    // contador. Como el reopen va ANTES, el board YA se re-abrió cuando el conteo falla; el error transitorio
    // se relanza para que Kafka reintente AMBOS (reopen idempotente).
    const transient = new Error('DB connection reset (transient)');
    const { svc, released, reopened, windowCalls } = build({ countThrows: transient });
    await svc.onModuleInit();

    const env = reassigningEnvelope();
    // El handler relanza el transitorio (Kafka reintenta), pero el reopen ya ocurrió.
    await expect(handlers.get('trip.reassigning')?.(env)).rejects.toThrow(transient);

    expect(released).toEqual([CANCEL_DRIVER_ID]); // liberó al conductor (antes del conteo)
    expect(reopened).toHaveLength(1); // EL BOARD SE RE-ABRIÓ pese a la falla del conteo
    expect(reopened[0]).toMatchObject({ tripId: VALID_TRIP_ID, driverId: CANCEL_DRIVER_ID });
    expect(windowCalls).toHaveLength(1); // el conteo SÍ se intentó (después del reopen), y fue el que falló

    await svc.onModuleDestroy();
  });

  it('NO cuenta (ni rompe) cuando el payload no trae driverId de perfil (id vacío del emisor)', async () => {
    const { svc, released, reopened, windowCalls } = build();
    await svc.onModuleInit();

    // Borde del emisor: trip.reassigning manda driverId '' si no había conductor asignado (imposible POST-accept,
    // pero defensa en profundidad). Sin id de perfil no se puede atribuir → no se cuenta ni se libera, pero el
    // board se re-abre igual (el pasajero no queda abandonado).
    const env = reassigningEnvelope({ driverId: '' });
    await handlers.get('trip.reassigning')?.(env);

    expect(windowCalls).toHaveLength(0);
    expect(released).toHaveLength(0);
    expect(reopened).toHaveLength(1);

    await svc.onModuleDestroy();
  });
});
