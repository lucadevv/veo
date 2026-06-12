/**
 * Dominó del cierre de pánico en el tiempo real de /family (seguridad física).
 *
 * Dos frentes:
 *  1) RealtimeStateService.clearPanic: simétrico a markPanic, idempotente (levanta la marca de pánico).
 *  2) RealtimeConsumerService.onPanicResolved (vía el handler 'panic.resolved'): RESTAURA el feed en vivo
 *     SOLO si FALSE_ALARM; un cierre RESOLVED (emergencia real) NO restaura — la máscara se mantiene
 *     porque el enlace pudo ser capturado por el agresor (test ADVERSARIAL).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createEnvelope, KafkaEventConsumer } from '@veo/events';
import { RealtimeStateService } from './realtime-state.service';
import { RealtimeConsumerService } from './realtime-consumer.service';
import type { FamilyGateway } from './family.gateway';
import type { PassengerGateway } from './passenger.gateway';
import type { Env } from '../config/env.schema';

// El bootstrap Kafka real no debe abrir sockets en el test.
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = new ConfigService<Env, true>({ KAFKA_BROKERS: 'localhost:9094' } as never);

function handlerFor(consumer: RealtimeConsumerService, eventType: string) {
  const handlers = (
    consumer as unknown as { handlers(): Record<string, (e: unknown) => Promise<void>> }
  ).handlers();
  return handlers[eventType]!;
}

function resolvedEnvelope(status: 'RESOLVED' | 'FALSE_ALARM') {
  return createEnvelope({
    eventType: 'panic.resolved',
    producer: 'panic-service',
    payload: {
      panicId: 'pn-1',
      tripId: 'trip-1',
      passengerId: 'pax-1',
      status,
      resolvedBy: 'op-1',
      at: new Date().toISOString(),
    },
  });
}

function build() {
  const state = new RealtimeStateService();
  const gateway = { cutFamilyForPanic: vi.fn() } as unknown as FamilyGateway;
  const passenger = {} as unknown as PassengerGateway;
  const consumer = new RealtimeConsumerService(config, gateway, passenger, state);
  return { consumer, state };
}

describe('RealtimeStateService · clearPanic (simétrico a markPanic)', () => {
  it('clearPanic levanta la marca; idempotente sobre un viaje no marcado', () => {
    const state = new RealtimeStateService();
    state.markPanic('trip-1');
    expect(state.isPanicked('trip-1')).toBe(true);

    state.clearPanic('trip-1');
    expect(state.isPanicked('trip-1')).toBe(false);

    // Idempotente: limpiar uno ya limpio no rompe.
    expect(() => state.clearPanic('trip-1')).not.toThrow();
    expect(state.isPanicked('trip-1')).toBe(false);
  });
});

describe('RealtimeConsumerService.onPanicResolved · restaura el feed condicionalmente', () => {
  it('FALSE_ALARM → clearPanic: el feed en vivo a /family vuelve (isPanicked=false)', async () => {
    const { consumer, state } = build();
    state.markPanic('trip-1');

    await handlerFor(consumer, 'panic.resolved')(resolvedEnvelope('FALSE_ALARM'));

    expect(state.isPanicked('trip-1')).toBe(false);
  });

  it('ADVERSARIAL · RESOLVED → NO restaura: la máscara se MANTIENE (isPanicked sigue true)', async () => {
    const { consumer, state } = build();
    state.markPanic('trip-1');

    await handlerFor(consumer, 'panic.resolved')(resolvedEnvelope('RESOLVED'));

    // PROPIEDAD DE SEGURIDAD: un RESOLVED no reabre el feed en vivo para la familia.
    expect(state.isPanicked('trip-1')).toBe(true);
  });
});
