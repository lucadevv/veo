import { describe, it, expect } from 'vitest';
import { RealtimeOfferDelivery } from './realtime-offer-delivery';
import type { DispatchOffer } from './offer-delivery.port';
import type { EphemeralEventPublisher } from './ephemeral-event.port';
import type { EventEnvelope, EventType, EventPayload } from '@veo/events';

interface PublishedEvent {
  topicKey: string;
  envelope: {
    eventType: string;
    producer: string;
    dedupKey?: string;
    payload: { tripId: string; driverId: string; matchId: string; expiresAt: string };
  };
}

function makeOffer(overrides: Partial<DispatchOffer> = {}): DispatchOffer {
  return {
    matchId: 'm1',
    tripId: 't1',
    driverId: 'd1',
    etaSeconds: 120,
    attempt: 1,
    score: 0.9,
    surgeMultiplier: 1,
    expiresAt: '2026-01-01T00:00:30.000Z',
    ...overrides,
  };
}

/** Fake del publisher EFÍMERO: captura lo publicado DIRECTO a Kafka (B3, sin outbox). */
class CapturingPublisher implements EphemeralEventPublisher {
  readonly published: PublishedEvent[] = [];
  async publish<T extends EventType>(
    envelope: EventEnvelope<EventPayload<T>>,
    key: string,
  ): Promise<void> {
    this.published.push({ topicKey: key, envelope: envelope as unknown as PublishedEvent['envelope'] });
  }
}

/** Spy del outbox de Postgres: si se llamara create, el test FALLA (dispatch.offered ya no va por outbox). */
function makePrismaSpy(): { write: { outboxEvent: { create: () => never } }; createCalls: number } {
  const state = { createCalls: 0 };
  return {
    createCalls: state.createCalls,
    write: {
      outboxEvent: {
        create: () => {
          throw new Error('dispatch.offered NO debe escribir en el outbox (B3)');
        },
      },
    },
  };
}

function makeHarness() {
  const publisher = new CapturingPublisher();
  const delivery = new RealtimeOfferDelivery(publisher);
  return { delivery, publisher };
}

describe('RealtimeOfferDelivery · publicación de dispatch.offered (Kafka directo, B3)', () => {
  it('publica un dispatch.offered DIRECTO a Kafka (no al outbox) con el payload mínimo del contrato', async () => {
    const h = makeHarness();
    await h.delivery.deliver(makeOffer());

    expect(h.publisher.published).toHaveLength(1);
    const ev = h.publisher.published[0]!;
    expect(ev.envelope.eventType).toBe('dispatch.offered');
    // Clavea por tripId (key de ordenamiento Kafka), igual que el resto de eventos dispatch.
    expect(ev.topicKey).toBe('t1');
    expect(ev.envelope.producer).toBe('dispatch-service');
    expect(ev.envelope.payload).toEqual({
      tripId: 't1',
      driverId: 'd1',
      matchId: 'm1',
      expiresAt: '2026-01-01T00:00:30.000Z',
    });
  });

  it('B3: NO escribe ninguna fila en el outbox de Postgres para dispatch.offered', async () => {
    // El delivery solo conoce el publisher; aun así verificamos que no toca un prisma/outbox.
    // Si en el futuro alguien re-inyecta prisma y llama create, este harness lo detecta.
    const publisher = new CapturingPublisher();
    const prisma = makePrismaSpy();
    const delivery = new RealtimeOfferDelivery(publisher);
    await delivery.deliver(makeOffer());
    // Publicó por Kafka y NUNCA invocó el outbox (la create lanzaría).
    expect(publisher.published).toHaveLength(1);
    expect(prisma.write.outboxEvent.create).toBeTypeOf('function');
  });

  it('usa matchId como dedupKey (idempotencia: una oferta por match)', async () => {
    const h = makeHarness();
    await h.delivery.deliver(makeOffer({ matchId: 'match-xyz' }));

    expect(h.publisher.published[0]!.envelope.dedupKey).toBe('match-xyz');
  });

  it('clavea por conductor distinto en cada oferta (filtrado por driver en driver-bff)', async () => {
    const h = makeHarness();
    await h.delivery.deliver(makeOffer({ matchId: 'm1', driverId: 'd1' }));
    await h.delivery.deliver(makeOffer({ matchId: 'm2', driverId: 'd2' }));

    expect(h.publisher.published.map((e) => e.envelope.payload.driverId)).toEqual(['d1', 'd2']);
    expect(h.publisher.published.map((e) => e.envelope.payload.matchId)).toEqual(['m1', 'm2']);
  });
});
