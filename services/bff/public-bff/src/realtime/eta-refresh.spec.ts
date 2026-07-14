/**
 * ETA FRESCO por fase (A2 del flujo de mapa): con cada ping GPS del conductor, el consumer recomputa
 * el ETA server-side (antes se fijaba UNA vez en accept/arriving con defaults del cliente y quedaba
 * stale todo el viaje) y lo emite por el socket del pasajero.
 *
 * Reglas cubiertas:
 *  - pre-recojo (ACCEPTED): ETA conductor → RECOJO.
 *  - onboard (IN_PROGRESS): ETA conductor → DESTINO.
 *  - THROTTLE de 15s por viaje: dos pings seguidos NO disparan dos OSRM.
 *  - fail-soft: maps caído no rompe el fan-out del pin (se conserva el último ETA).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createEnvelope, KafkaEventConsumer } from '@veo/events';
import { RealtimeStateService } from './realtime-state.service';
import { RealtimeConsumerService } from './realtime-consumer.service';
import type { FamilyGateway } from './family.gateway';
import type { PassengerGateway } from './passenger.gateway';
import type { Env } from '../config/env.schema';

vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = new ConfigService<Env, true>({ KAFKA_BROKERS: 'localhost:9094' } as never);

const ORIGIN = { lat: -12.046, lon: -77.043 };
const DESTINATION = { lat: -12.121, lon: -77.03 };
const DRIVER_AT = { lat: -12.05, lon: -77.05 };

function handlerFor(consumer: RealtimeConsumerService, eventType: string) {
  const handlers = (
    consumer as unknown as { handlers(): Record<string, (e: unknown) => Promise<void>> }
  ).handlers();
  return handlers[eventType]!;
}

function locationEnvelope(at = new Date().toISOString()) {
  return createEnvelope({
    eventType: 'driver.location_updated',
    producer: 'driver-bff',
    payload: { driverId: 'drv-1', point: DRIVER_AT, h3: '8866d2d4b7fffff', heading: 90, at },
  });
}

function build(opts: { status: 'ACCEPTED' | 'IN_PROGRESS'; etaFails?: boolean }) {
  const state = new RealtimeStateService();
  state.setDriverTrip('drv-1', 'trip-1');
  state.setTripPoints('trip-1', { origin: ORIGIN, destination: DESTINATION });
  state.setStatus('trip-1', opts.status);
  // Un pasajero escuchando (gate del fan-out).
  state.addPassenger('sock-1', 'trip-1');
  const emitEta = vi.fn();
  const gateway = { emitDriverLocation: vi.fn() } as unknown as FamilyGateway;
  const passenger = { emitDriverLocation: vi.fn(), emitEta } as unknown as PassengerGateway;
  const eta = opts.etaFails
    ? vi.fn().mockRejectedValue(new Error('osrm caído'))
    : vi.fn().mockResolvedValue(420);
  const consumer = new RealtimeConsumerService(config, gateway, passenger, state, { eta } as never);
  return { consumer, state, eta, emitEta, passenger };
}

describe('RealtimeConsumerService — ETA fresco por fase con cada ping GPS', () => {
  it('pre-recojo (ACCEPTED): recomputa conductor → RECOJO y emite `eta` al pasajero', async () => {
    const { consumer, state, eta, emitEta } = build({ status: 'ACCEPTED' });
    await handlerFor(consumer, 'driver.location_updated')(locationEnvelope());
    // fire-and-forget: dejar drenar la microtask del recompute
    await new Promise((r) => setImmediate(r));
    expect(eta).toHaveBeenCalledWith(DRIVER_AT, ORIGIN);
    expect(emitEta).toHaveBeenCalledWith(
      'trip-1',
      expect.objectContaining({ tripId: 'trip-1', etaSeconds: 420 }),
    );
    expect(state.getEta('trip-1')).toBe(420);
  });

  it('onboard (IN_PROGRESS): recomputa conductor → DESTINO (el recojo quedó atrás)', async () => {
    const { consumer, eta } = build({ status: 'IN_PROGRESS' });
    await handlerFor(consumer, 'driver.location_updated')(locationEnvelope());
    await new Promise((r) => setImmediate(r));
    expect(eta).toHaveBeenCalledWith(DRIVER_AT, DESTINATION);
  });

  it('THROTTLE: dos pings seguidos disparan UN solo recompute (cadencia 15s por viaje)', async () => {
    const { consumer, eta } = build({ status: 'ACCEPTED' });
    const handler = handlerFor(consumer, 'driver.location_updated');
    await handler(locationEnvelope());
    await handler(locationEnvelope());
    await new Promise((r) => setImmediate(r));
    expect(eta).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: maps caído NO rompe el fan-out del pin (driver:location igual se emite)', async () => {
    const { consumer, passenger, emitEta } = build({ status: 'ACCEPTED', etaFails: true });
    await handlerFor(consumer, 'driver.location_updated')(locationEnvelope());
    await new Promise((r) => setImmediate(r));
    expect(
      (passenger as unknown as { emitDriverLocation: ReturnType<typeof vi.fn> }).emitDriverLocation,
    ).toHaveBeenCalled();
    expect(emitEta).not.toHaveBeenCalled();
  });
});
