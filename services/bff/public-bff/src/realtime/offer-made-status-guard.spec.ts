/**
 * GUARD del status memorizado en `onOfferMade` (2026-07-15).
 *
 * El consumer fija el status a REQUESTED al llegar una oferta SOLO para corregir un EXPIRED stale de un
 * ciclo previo sin ofertas (así la reconexión/emitSnapshot no re-empuja ese EXPIRED sobre un board sano).
 * PERO no debe DEGRADAR un status vivo superior: una oferta durante REASSIGNING (board re-abierto tras la
 * cancelación del conductor post-accept) tiene que CONSERVAR REASSIGNING — pisarlo con REQUESTED hacía que
 * el socket (REQUESTED) contradijera al REST (REASSIGNING) → la fase del pasajero oscilaba (loop infinito).
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

function handlerFor(consumer: RealtimeConsumerService, eventType: string) {
  const handlers = (
    consumer as unknown as { handlers(): Record<string, (e: unknown) => Promise<void>> }
  ).handlers();
  return handlers[eventType]!;
}

function offerMadeEnvelope() {
  return createEnvelope({
    eventType: 'dispatch.offer_made',
    producer: 'dispatch-service',
    payload: {
      tripId: 'trip-1',
      driverId: 'drv-1',
      kind: 'ACCEPT_PRICE',
      priceCents: 4700,
      etaSeconds: 120,
    },
  });
}

function build(initialStatus?: 'REASSIGNING' | 'EXPIRED' | 'MATCHING') {
  const state = new RealtimeStateService();
  if (initialStatus) state.setStatus('trip-1', initialStatus);
  const gateway = {} as unknown as FamilyGateway;
  const emitOfferMade = vi.fn();
  const passenger = { emitOfferMade } as unknown as PassengerGateway;
  const consumer = new RealtimeConsumerService(config, gateway, passenger, state, {
    eta: vi.fn(),
  } as never);
  return { consumer, state, emitOfferMade };
}

describe('RealtimeConsumerService.onOfferMade — guard del status memorizado', () => {
  it('status REASSIGNING → una oferta NO lo degrada (conserva REASSIGNING, sin oscilación)', async () => {
    const { consumer, state, emitOfferMade } = build('REASSIGNING');
    await handlerFor(consumer, 'dispatch.offer_made')(offerMadeEnvelope());
    expect(state.getStatus('trip-1')).toBe('REASSIGNING'); // NO pisado a REQUESTED
    expect(emitOfferMade).toHaveBeenCalledOnce(); // la oferta igual se reenvía al pasajero
  });

  it('status MATCHING → tampoco se degrada (solo EXPIRED/ausente se corrige)', async () => {
    const { consumer, state } = build('MATCHING');
    await handlerFor(consumer, 'dispatch.offer_made')(offerMadeEnvelope());
    expect(state.getStatus('trip-1')).toBe('MATCHING');
  });

  it('status EXPIRED (stale) → SÍ se corrige a REQUESTED (intención original preservada)', async () => {
    const { consumer, state } = build('EXPIRED');
    await handlerFor(consumer, 'dispatch.offer_made')(offerMadeEnvelope());
    expect(state.getStatus('trip-1')).toBe('REQUESTED');
  });

  it('status ausente → se fija a REQUESTED (board recién abierto)', async () => {
    const { consumer, state } = build();
    await handlerFor(consumer, 'dispatch.offer_made')(offerMadeEnvelope());
    expect(state.getStatus('trip-1')).toBe('REQUESTED');
  });
});
