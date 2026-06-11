/**
 * EventConsumerService · handlers de "degradación honesta" (trip.expired / trip.failed).
 *
 * Verifica que el pasajero SIEMPRE se entera cuando la puja no encuentra conductor (trip.expired)
 * o cuando el viaje no se puede completar (trip.failed). Mockeamos @veo/events para capturar los
 * handlers que el servicio registra (sin Kafka real) y los disparamos con envelopes reales contra
 * un NotificationEngine real (store en memoria) — así el test cubre el camino completo de envío.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationChannel } from '@veo/shared-types';
import { createEnvelope, type EventEnvelope } from '@veo/events';
import type * as VeoEvents from '@veo/events';
import { NotificationEngine } from '../engine/notification.engine';
import { NotificationPriority } from '../engine/types';
import { RetryPolicy } from '../engine/retry.policy';
import { TEMPLATE_KEYS } from '../engine/template.catalog';
import type { DeviceTarget } from '../devices/device-token.repository';
import type {
  CreateNotificationInput,
  DispatchResult,
  MessageDispatcher,
  NotificationRecord,
  NotificationStore,
  RenderedMessage,
  TemplateRenderer,
} from '../engine/types';

/** Fake del consumidor Kafka: captura los handlers registrados con .on() para dispararlos a mano. */
type Handler = (envelope: EventEnvelope<unknown>) => Promise<void>;
const registered = new Map<string, Handler>();

/**
 * Poison-guard UNIFICADO (Lote P): TODOS los handlers que resuelven el token del device-store pasan
 * por isUuid (antes solo el "flujo crítico"; expired/failed/bid_posted/reassigning/completed usaban
 * la variante sin guard — copy-paste drift resuelto hacia el guard, que evita el crash-loop P2023).
 * ⇒ los passengerId de los fixtures son UUIDs canónicos, como ya documentaba el bloque del flujo
 * crítico. La intención de cada test (el pasajero SIEMPRE se entera / degrada honesto) no cambia.
 */
const PAX_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAX_SIN_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('@veo/events', async (importOriginal) => {
  const actual = await importOriginal<typeof VeoEvents>();
  class FakeConsumer {
    on(eventType: string, handler: Handler): this {
      registered.set(eventType, handler);
      return this;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return {
    ...actual,
    createKafka: () => ({}),
    KafkaEventConsumer: FakeConsumer,
  };
});

/** Store en memoria (doble determinista, sin Prisma) para observar lo que el motor encola. */
class InMemoryStore implements NotificationStore {
  readonly records = new Map<string, NotificationRecord>();
  private readonly dedup = new Map<string, string>();

  async findByDedupKey(dedupKey: string): Promise<NotificationRecord | null> {
    const id = this.dedup.get(dedupKey);
    return id ? (this.records.get(id) ?? null) : null;
  }
  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const rec: NotificationRecord = {
      ...input,
      status: 'PENDING',
      attempts: 0,
      sentAt: null,
      deliveredAt: null,
      failedReason: null,
      createdAt: new Date(),
    };
    this.records.set(rec.id, rec);
    if (rec.dedupKey) this.dedup.set(rec.dedupKey, rec.id);
    return rec;
  }
  async findById(id: string): Promise<NotificationRecord | null> {
    return this.records.get(id) ?? null;
  }
  async findByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()].filter((r) => r.recipientId === recipientId).slice(0, limit);
  }
  async findInboxByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.recipientId === recipientId && r.channel === 'PUSH')
      .slice(0, limit);
  }
  async findDue(now: Date, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'PENDING' && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .slice(0, limit);
  }
  async markSent(): Promise<void> {}
  async markFailed(): Promise<void> {}
  async scheduleRetry(): Promise<void> {}
}

const renderer: TemplateRenderer = {
  async render(rec: NotificationRecord): Promise<RenderedMessage> {
    return { to: String(rec.payload.to ?? ''), body: 'cuerpo' };
  },
};

class NoopDispatcher implements MessageDispatcher {
  async dispatch(): Promise<DispatchResult> {
    return { status: 'sent' };
  }
}

const policy = new RetryPolicy({ baseMs: 1_000, factor: 2, maxMs: 60_000, defaultMaxAttempts: 5, jitter: false });

/** Repo de dispositivos fake: devuelve un token registrado para el pasajero (cuando no llega en el evento). */
function fakeDevices(tokensByUser: Record<string, DeviceTarget[]>): {
  findActiveByUser: (userId: string) => Promise<DeviceTarget[]>;
} {
  return {
    findActiveByUser: async (userId: string) => tokensByUser[userId] ?? [],
  };
}

/**
 * Construye el EventConsumerService con dependencias reales (motor) y fakes (devices/config) y
 * ejecuta onModuleInit para que registre los handlers en el FakeConsumer.
 */
async function buildAndInit(tokensByUser: Record<string, DeviceTarget[]>) {
  registered.clear();
  const store = new InMemoryStore();
  const engine = new NotificationEngine(store, renderer, new NoopDispatcher(), policy);
  const devices = fakeDevices(tokensByUser);

  // Import dinámico DESPUÉS del vi.mock para que el servicio use el FakeConsumer.
  const { EventConsumerService } = await import('./event-consumer.service');
  const config = {
    getOrThrow: (key: string) => (key === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
    get: () => undefined,
  } as unknown as ConstructorParameters<typeof EventConsumerService>[2];

  const service = new EventConsumerService(
    engine,
    devices as unknown as ConstructorParameters<typeof EventConsumerService>[1],
    config,
  );
  await service.onModuleInit();
  return { store };
}

function expiredEnvelope(passengerId: string): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'trip.expired',
    producer: 'trip-service',
    payload: {
      tripId: 'trip-1',
      passengerId,
      fromStatus: 'REQUESTED',
      staleMinutes: 5,
      at: new Date().toISOString(),
    },
  });
}

function failedEnvelope(passengerId: string): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'trip.failed',
    producer: 'trip-service',
    payload: {
      tripId: 'trip-2',
      passengerId,
      fromStatus: 'IN_PROGRESS',
      staleMinutes: 30,
      at: new Date().toISOString(),
    },
  });
}

function bidPostedEnvelope(passengerId: string, scheduled: boolean | undefined): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'trip.bid_posted',
    producer: 'trip-service',
    payload: {
      tripId: 'trip-9',
      passengerId,
      bidCents: 1500,
      vehicleType: 'CAR',
      origin: { lat: -12.04, lon: -77.04 },
      windowSec: 60,
      negotiationSeq: 1,
      ...(scheduled === undefined ? {} : { scheduled }),
    },
  });
}

describe('EventConsumerService · #1 PUJA programada (deep-link al board)', () => {
  beforeEach(() => {
    registered.clear();
  });

  it('se suscribe a trip.bid_posted', async () => {
    await buildAndInit({});
    expect(registered.has('trip.bid_posted')).toBe(true);
  });

  it('scheduled=true → push con deep-link al OffersBoard (token del almacén)', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-S', platform: 'android' }] });
    await registered.get('trip.bid_posted')!(bidPostedEnvelope(PAX_UUID, true));

    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.channel).toBe(NotificationChannel.PUSH);
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_SCHEDULED_READY);
    expect(rec.payload.to).toBe('tok-S');
    expect(rec.payload.data).toEqual({ tripId: 'trip-9', screen: 'OffersBoard' });
  });

  it('scheduled=false (puja inmediata / rebid) → NO pushea: el pasajero ya está en el board', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-S', platform: 'android' }] });
    await registered.get('trip.bid_posted')!(bidPostedEnvelope(PAX_UUID, false));
    expect(store.records.size).toBe(0);
  });

  it('sin flag scheduled (compat N-2) → NO pushea', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-S', platform: 'android' }] });
    await registered.get('trip.bid_posted')!(bidPostedEnvelope(PAX_UUID, undefined));
    expect(store.records.size).toBe(0);
  });

  it('es idempotente: un bid_posted programado duplicado no pushea dos veces', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-S', platform: 'android' }] });
    await registered.get('trip.bid_posted')!(bidPostedEnvelope(PAX_UUID, true));
    await registered.get('trip.bid_posted')!(bidPostedEnvelope(PAX_UUID, true));
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · H3 reasignación + recibo (deep-link)', () => {
  beforeEach(() => {
    registered.clear();
  });

  it('se suscribe a trip.reassigning y trip.completed', async () => {
    await buildAndInit({});
    expect(registered.has('trip.reassigning')).toBe(true);
    expect(registered.has('trip.completed')).toBe(true);
  });

  it('trip.reassigning → push con deep-link al OffersBoard re-abierto', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-R', platform: 'android' }] });
    await registered.get('trip.reassigning')!(
      createEnvelope({
        eventType: 'trip.reassigning',
        producer: 'trip-service',
        payload: {
          tripId: 'trip-R',
          driverId: 'drv-X',
          passengerId: PAX_UUID,
          vehicleType: 'CAR',
          origin: { lat: -12, lon: -77 },
          bidCents: 1500,
          reason: 'driver_cancelled',
          negotiationSeq: 2,
        },
      }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_REASSIGNING);
    expect(rec.payload.data).toEqual({ tripId: 'trip-R', screen: 'OffersBoard' });
  });

  it('trip.completed con passengerId → push de recibo (deep-link al detalle)', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-C', platform: 'ios' }] });
    await registered.get('trip.completed')!(
      createEnvelope({
        eventType: 'trip.completed',
        producer: 'trip-service',
        payload: {
          tripId: 'trip-C',
          fareCents: 1800,
          distanceMeters: 5000,
          durationSeconds: 900,
          passengerId: PAX_UUID,
        },
      }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_COMPLETED);
    expect(rec.payload.data).toEqual({ tripId: 'trip-C', screen: 'TripActive' });
  });

  it('trip.completed SIN passengerId (compat) → no encola recibo', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-C', platform: 'ios' }] });
    await registered.get('trip.completed')!(
      createEnvelope({
        eventType: 'trip.completed',
        producer: 'trip-service',
        payload: { tripId: 'trip-C2', fareCents: 1800, distanceMeters: 5000, durationSeconds: 900 },
      }),
    );
    expect(store.records.size).toBe(0);
  });
});

describe('EventConsumerService · degradación honesta', () => {
  beforeEach(() => {
    registered.clear();
  });

  it('se suscribe a trip.expired y trip.failed', async () => {
    await buildAndInit({});
    expect(registered.has('trip.expired')).toBe(true);
    expect(registered.has('trip.failed')).toBe(true);
  });

  it('trip.expired notifica al pasajero con un mensaje no vacío (token del almacén)', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-A', platform: 'android' }] });
    await registered.get('trip.expired')!(expiredEnvelope(PAX_UUID));

    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.recipientId).toBe(PAX_UUID);
    expect(rec.channel).toBe(NotificationChannel.PUSH);
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_EXPIRED);
    expect(rec.payload.to).toBe('tok-A');

    const rendered = await renderer.render(rec);
    expect(rendered.body.length).toBeGreaterThan(0);
  });

  it('trip.failed notifica al pasajero con un mensaje no vacío', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-B', platform: 'ios' }] });
    await registered.get('trip.failed')!(failedEnvelope(PAX_UUID));

    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.recipientId).toBe(PAX_UUID);
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_FAILED);
    expect(rec.payload.to).toBe('tok-B');
  });

  it('usa el token enriquecido del evento si viene en el payload', async () => {
    const { store } = await buildAndInit({});
    const env = createEnvelope({
      eventType: 'trip.expired',
      producer: 'trip-service',
      payload: {
        tripId: 'trip-3',
        passengerId: PAX_UUID,
        fromStatus: 'REQUESTED',
        staleMinutes: 5,
        at: new Date().toISOString(),
        passengerPushToken: 'tok-EVENT',
        platform: 'android',
      },
    });
    await registered.get('trip.expired')!(env);

    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload.to).toBe('tok-EVENT');
  });

  it('sin token del pasajero (evento ni almacén) no encola nada', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.failed')!(failedEnvelope(PAX_SIN_TOKEN));
    expect(store.records.size).toBe(0);
  });

  it('es idempotente: un trip.expired duplicado no notifica dos veces', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-A', platform: 'android' }] });
    await registered.get('trip.expired')!(expiredEnvelope(PAX_UUID));
    await registered.get('trip.expired')!(expiredEnvelope(PAX_UUID));
    expect(store.records.size).toBe(1);
  });

  it('es idempotente: un trip.failed duplicado no notifica dos veces', async () => {
    const { store } = await buildAndInit({ [PAX_UUID]: [{ token: 'tok-B', platform: 'ios' }] });
    await registered.get('trip.failed')!(failedEnvelope(PAX_UUID));
    await registered.get('trip.failed')!(failedEnvelope(PAX_UUID));
    expect(store.records.size).toBe(1);
  });
});

// ───────────────────── Flujo crítico del PASAJERO (handlers nuevos) ─────────────────────
// Estos handlers usan safeResolveTargets (poison-guard isUuid) ⇒ el passengerId DEBE ser un UUID
// canónico para que resuelva el token del almacén. Usamos UUIDs reales en los fixtures.
const PAX = '11111111-1111-4111-8111-111111111111';
const PAX2 = '22222222-2222-4222-8222-222222222222';

function env(eventType: string, payload: Record<string, unknown>): EventEnvelope<unknown> {
  return createEnvelope({ eventType, producer: 'test', payload });
}

describe('EventConsumerService · trip.accepted → "tu conductor confirmó"', () => {
  beforeEach(() => registered.clear());

  it('se suscribe a trip.accepted', async () => {
    await buildAndInit({});
    expect(registered.has('trip.accepted')).toBe(true);
  });

  it('payload válido → push TRIP_ACCEPTED al pasajero (eta en minutos, deep-link)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-A', platform: 'android' }] });
    await registered.get('trip.accepted')!(
      env('trip.accepted', { tripId: 'trip-A', driverId: 'drv-1', etaSeconds: 300, passengerId: PAX, driverName: 'Carlos' }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.channel).toBe(NotificationChannel.PUSH);
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_ACCEPTED);
    expect(rec.payload.to).toBe('tok-A');
    expect(rec.payload.vars).toMatchObject({ driverName: 'Carlos', etaMinutes: 5 });
    expect(rec.payload.data).toMatchObject({ tripId: 'trip-A', screen: 'TripActive' });
  });

  it('sin token del pasajero → degrada (no encola)', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.accepted')!(env('trip.accepted', { tripId: 'trip-A', driverId: 'd', etaSeconds: 300, passengerId: PAX }));
    expect(store.records.size).toBe(0);
  });

  it('redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-A', platform: 'android' }] });
    const e = env('trip.accepted', { tripId: 'trip-A', driverId: 'd', etaSeconds: 300, passengerId: PAX });
    await registered.get('trip.accepted')!(e);
    await registered.get('trip.accepted')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · trip.started → "tu viaje empezó"', () => {
  beforeEach(() => registered.clear());

  it('payload válido → push TRIP_STARTED al pasajero', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-S', platform: 'ios' }] });
    await registered.get('trip.started')!(
      env('trip.started', { tripId: 'trip-S', driverId: 'd', startedAt: new Date().toISOString(), passengerId: PAX }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_STARTED);
    expect(rec.payload.data).toMatchObject({ tripId: 'trip-S', screen: 'TripActive' });
  });

  it('sin passengerId → degrada', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-S', platform: 'ios' }] });
    await registered.get('trip.started')!(env('trip.started', { tripId: 'trip-S', driverId: 'd', startedAt: new Date().toISOString() }));
    expect(store.records.size).toBe(0);
  });

  it('redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-S', platform: 'ios' }] });
    const e = env('trip.started', { tripId: 'trip-S', driverId: 'd', startedAt: '2026-01-01T00:00:00Z', passengerId: PAX });
    await registered.get('trip.started')!(e);
    await registered.get('trip.started')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · trip.arriving → "tu conductor está llegando"', () => {
  beforeEach(() => registered.clear());

  it('payload válido → push TRIP_ARRIVING al pasajero', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-R', platform: 'android' }] });
    await registered.get('trip.arriving')!(
      env('trip.arriving', { tripId: 'trip-R', driverId: 'd', etaSeconds: 120, at: '2026-01-01T00:00:00Z', passengerId: PAX, driverName: 'Ana' }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_ARRIVING);
    expect(rec.payload.vars).toMatchObject({ driverName: 'Ana' });
  });

  it('sin token → degrada', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.arriving')!(env('trip.arriving', { tripId: 't', driverId: 'd', etaSeconds: 120, at: 'x', passengerId: PAX }));
    expect(store.records.size).toBe(0);
  });

  it('redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-R', platform: 'android' }] });
    const e = env('trip.arriving', { tripId: 'trip-R', driverId: 'd', etaSeconds: 120, at: 'x', passengerId: PAX });
    await registered.get('trip.arriving')!(e);
    await registered.get('trip.arriving')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · trip.arrived → "tu conductor llegó" (+ ventana de espera)', () => {
  beforeEach(() => registered.clear());

  it('sin ventana → push TRIP_ARRIVED simple', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-V', platform: 'android' }] });
    await registered.get('trip.arrived')!(env('trip.arrived', { tripId: 'trip-V', driverId: 'd', at: 'x', passengerId: PAX, driverName: 'Luis' }));
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_ARRIVED);
    expect(rec.payload.vars).toMatchObject({ driverName: 'Luis' });
    expect((rec.payload.vars as Record<string, unknown>).waitMinutes).toBeUndefined();
  });

  it('con waitWindowSeconds → push TRIP_ARRIVED_WAIT con la ventana en minutos', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-V', platform: 'android' }] });
    await registered.get('trip.arrived')!(
      env('trip.arrived', { tripId: 'trip-V', driverId: 'd', at: 'x', passengerId: PAX, waitWindowSeconds: 300 }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_ARRIVED_WAIT);
    expect(rec.payload.vars).toMatchObject({ waitMinutes: 5 });
  });

  it('sin token → degrada', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.arrived')!(env('trip.arrived', { tripId: 't', driverId: 'd', at: 'x', passengerId: PAX }));
    expect(store.records.size).toBe(0);
  });

  it('redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-V', platform: 'android' }] });
    const e = env('trip.arrived', { tripId: 'trip-V', driverId: 'd', at: 'x', passengerId: PAX });
    await registered.get('trip.arrived')!(e);
    await registered.get('trip.arrived')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · trip.cancelled → confirmación honesta', () => {
  beforeEach(() => registered.clear());

  it('by=PASSENGER → push "cancelaste tu viaje"', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-C', platform: 'android' }] });
    await registered.get('trip.cancelled')!(env('trip.cancelled', { tripId: 'trip-C', by: 'PASSENGER', penaltyCents: 0, passengerId: PAX }));
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_CANCELLED_BY_PASSENGER);
  });

  it('by=DRIVER (pre-recojo) → push "tu conductor canceló"', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-C', platform: 'android' }] });
    await registered.get('trip.cancelled')!(env('trip.cancelled', { tripId: 'trip-C', by: 'DRIVER', penaltyCents: 0, passengerId: PAX }));
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_CANCELLED_BY_DRIVER);
  });

  it('by=SYSTEM → no encola (se cubre con expired/failed)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-C', platform: 'android' }] });
    await registered.get('trip.cancelled')!(env('trip.cancelled', { tripId: 'trip-C', by: 'SYSTEM', penaltyCents: 0, passengerId: PAX }));
    expect(store.records.size).toBe(0);
  });

  it('sin token → degrada', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.cancelled')!(env('trip.cancelled', { tripId: 't', by: 'PASSENGER', penaltyCents: 0, passengerId: PAX }));
    expect(store.records.size).toBe(0);
  });

  it('redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-C', platform: 'android' }] });
    const e = env('trip.cancelled', { tripId: 'trip-C', by: 'PASSENGER', penaltyCents: 0, passengerId: PAX });
    await registered.get('trip.cancelled')!(e);
    await registered.get('trip.cancelled')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · payment.captured / refunded', () => {
  beforeEach(() => registered.clear());

  it('payment.captured → push "pago confirmado · S/X.XX" (grossCents → soles)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-P', platform: 'android' }] });
    await registered.get('payment.captured')!(
      env('payment.captured', { paymentId: 'pay-1', tripId: 'trip-1', method: 'YAPE', grossCents: 1850, commissionCents: 200, passengerId: PAX }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_CAPTURED);
    expect(rec.payload.vars).toMatchObject({ amount: '18.50' });
  });

  it('payment.refunded → push "te devolvimos S/X.XX" (amountCents → soles)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-P', platform: 'android' }] });
    await registered.get('payment.refunded')!(
      env('payment.refunded', { paymentId: 'pay-1', tripId: 'trip-1', amountCents: 500, approvedBy: 'op-1', passengerId: PAX }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_REFUNDED);
    expect(rec.payload.vars).toMatchObject({ amount: '5.00' });
  });

  it('captured sin passengerId → degrada', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-P', platform: 'android' }] });
    await registered.get('payment.captured')!(env('payment.captured', { paymentId: 'p', tripId: 't', method: 'CASH', grossCents: 1000, commissionCents: 0 }));
    expect(store.records.size).toBe(0);
  });

  it('captured redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-P', platform: 'android' }] });
    const e = env('payment.captured', { paymentId: 'pay-1', tripId: 't', method: 'YAPE', grossCents: 1850, commissionCents: 0, passengerId: PAX });
    await registered.get('payment.captured')!(e);
    await registered.get('payment.captured')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · payment.cash_pending → "confirma tu pago en efectivo"', () => {
  beforeEach(() => registered.clear());

  it('se suscribe a payment.cash_pending', async () => {
    await buildAndInit({});
    expect(registered.has('payment.cash_pending')).toBe(true);
  });

  it('payload válido → push PAYMENT_CASH_PENDING al PASAJERO (monto en soles, deep-link CashConfirm)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-CASH', platform: 'android' }] });
    await registered.get('payment.cash_pending')!(
      env('payment.cash_pending', { paymentId: 'pay-9', tripId: 'trip-9', grossCents: 2000, passengerId: PAX }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.channel).toBe(NotificationChannel.PUSH);
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_CASH_PENDING);
    expect(rec.recipientId).toBe(PAX);
    expect(rec.payload.to).toBe('tok-CASH');
    expect(rec.payload.vars).toMatchObject({ amount: '20.00' });
    expect(rec.payload.data).toMatchObject({ tripId: 'trip-9', paymentId: 'pay-9', screen: 'CashConfirm' });
  });

  it('sin passengerId / sin token (evento ni almacén) → degrada honesto (no encola)', async () => {
    const { store } = await buildAndInit({});
    await registered.get('payment.cash_pending')!(
      env('payment.cash_pending', { paymentId: 'pay-9', tripId: 'trip-9', grossCents: 2000 }),
    );
    expect(store.records.size).toBe(0);
  });

  it('redelivery del mismo cash_pending → no empuja dos veces (dedup por paymentId)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-CASH', platform: 'android' }] });
    const e = env('payment.cash_pending', { paymentId: 'pay-9', tripId: 'trip-9', grossCents: 2000, passengerId: PAX });
    await registered.get('payment.cash_pending')!(e);
    await registered.get('payment.cash_pending')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · penalidad de cancelación (F2 recorded / F2.3 collected)', () => {
  const DRV = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => registered.clear());

  it('se suscribe a los dos eventos de penalidad', async () => {
    await buildAndInit({});
    expect(registered.has('payment.cancellation_penalty_recorded')).toBe(true);
    expect(registered.has('payment.cancellation_penalty_collected')).toBe(true);
  });

  it('recorded → push PAYMENT_PENALTY_RECORDED al pasajero (monto en soles, deep-link a pagar)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-PEN', platform: 'android' }] });
    await registered.get('payment.cancellation_penalty_recorded')!(
      env('payment.cancellation_penalty_recorded', {
        penaltyId: 'pen-1', tripId: 'trip-1', passengerId: PAX, driverId: DRV,
        penaltyCents: 800, driverCompensationCents: 400, platformCents: 400,
      }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_PENALTY_RECORDED);
    expect(rec.recipientId).toBe(PAX);
    expect(rec.payload.vars).toMatchObject({ amount: '8.00' });
    expect(rec.payload.data).toMatchObject({ tripId: 'trip-1', penaltyId: 'pen-1', screen: 'CancellationPenalty' });
  });

  it('recorded sin token del pasajero → degrada (no encola)', async () => {
    const { store } = await buildAndInit({});
    await registered.get('payment.cancellation_penalty_recorded')!(
      env('payment.cancellation_penalty_recorded', {
        penaltyId: 'pen-1', tripId: 't', passengerId: PAX, penaltyCents: 800, driverCompensationCents: 0, platformCents: 800,
      }),
    );
    expect(store.records.size).toBe(0);
  });

  it('collected → DOS pushes: pasajero ("ya puedes pedir") y conductor ("recibiste S/Y")', async () => {
    const { store } = await buildAndInit({
      [PAX]: [{ token: 'tok-PAX', platform: 'android' }],
      [DRV]: [{ token: 'tok-DRV', platform: 'ios' }],
    });
    await registered.get('payment.cancellation_penalty_collected')!(
      env('payment.cancellation_penalty_collected', {
        penaltyId: 'pen-2', tripId: 'trip-2', passengerId: PAX, driverId: DRV,
        penaltyCents: 800, driverCompensationCents: 400, platformCents: 400, settlementPaymentId: 'pay-x',
      }),
    );
    const recs = [...store.records.values()];
    expect(recs).toHaveLength(2);
    const pax = recs.find((r) => r.recipientId === PAX)!;
    const drv = recs.find((r) => r.recipientId === DRV)!;
    expect(pax.template).toBe(TEMPLATE_KEYS.PAYMENT_PENALTY_COLLECTED);
    expect(pax.payload.vars).toMatchObject({ amount: '8.00' }); // penaltyCents
    expect(drv.template).toBe(TEMPLATE_KEYS.PAYMENT_PENALTY_DRIVER_COMP);
    expect(drv.payload.vars).toMatchObject({ amount: '4.00' }); // driverCompensationCents
  });

  it('collected sin conductor → SOLO el push del pasajero', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-PAX', platform: 'android' }] });
    await registered.get('payment.cancellation_penalty_collected')!(
      env('payment.cancellation_penalty_collected', {
        penaltyId: 'pen-3', tripId: 't', passengerId: PAX,
        penaltyCents: 500, driverCompensationCents: 0, platformCents: 500, settlementPaymentId: 'pay-y',
      }),
    );
    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    expect(recs[0]!.recipientId).toBe(PAX);
    expect(recs[0]!.template).toBe(TEMPLATE_KEYS.PAYMENT_PENALTY_COLLECTED);
  });

  it('collected redelivery → no duplica ninguno de los dos pushes', async () => {
    const { store } = await buildAndInit({
      [PAX]: [{ token: 'tok-PAX', platform: 'android' }],
      [DRV]: [{ token: 'tok-DRV', platform: 'ios' }],
    });
    const e = env('payment.cancellation_penalty_collected', {
      penaltyId: 'pen-2', tripId: 'trip-2', passengerId: PAX, driverId: DRV,
      penaltyCents: 800, driverCompensationCents: 400, platformCents: 400, settlementPaymentId: 'pay-x',
    });
    await registered.get('payment.cancellation_penalty_collected')!(e);
    await registered.get('payment.cancellation_penalty_collected')!(e);
    expect(store.records.size).toBe(2); // 1 pasajero + 1 conductor, sin duplicar
  });
});

describe('EventConsumerService · afiliación Yape (userId directo)', () => {
  beforeEach(() => registered.clear());

  it('activated → push "Yape quedó vinculado"', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-Y', platform: 'android' }] });
    await registered.get('payment.affiliation_activated')!(
      env('payment.affiliation_activated', { affiliationId: 'aff-1', userId: PAX, wallet: 'YAPE', at: 'x' }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_AFFILIATION_ACTIVATED);
    expect(rec.recipientId).toBe(PAX);
  });

  it('expired → push "vuelve a vincular tu Yape"', async () => {
    const { store } = await buildAndInit({ [PAX2]: [{ token: 'tok-Z', platform: 'ios' }] });
    await registered.get('payment.affiliation_expired')!(
      env('payment.affiliation_expired', { affiliationId: 'aff-2', userId: PAX2, wallet: 'YAPE', at: 'x' }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.PAYMENT_AFFILIATION_EXPIRED);
  });

  it('sin token → degrada', async () => {
    const { store } = await buildAndInit({});
    await registered.get('payment.affiliation_activated')!(env('payment.affiliation_activated', { affiliationId: 'a', userId: PAX, wallet: 'YAPE', at: 'x' }));
    expect(store.records.size).toBe(0);
  });

  it('activated redelivery → no duplica', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-Y', platform: 'android' }] });
    const e = env('payment.affiliation_activated', { affiliationId: 'aff-1', userId: PAX, wallet: 'YAPE', at: 'x' });
    await registered.get('payment.affiliation_activated')!(e);
    await registered.get('payment.affiliation_activated')!(e);
    expect(store.records.size).toBe(1);
  });
});

describe('EventConsumerService · S3 trip.child_code_failed (BR-T07, alerta al padre/madre)', () => {
  beforeEach(() => registered.clear());

  it('se suscribe a trip.child_code_failed', async () => {
    await buildAndInit({});
    expect(registered.has('trip.child_code_failed')).toBe(true);
  });

  it('código incorrecto → push CRÍTICO al pasajero dueño de la cuenta con deep-link al viaje activo', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-K', platform: 'android' }] });
    await registered.get('trip.child_code_failed')!(
      env('trip.child_code_failed', { tripId: 'trip-K', driverId: 'drv-1', attempt: 1, at: '2026-06-10T00:00:00Z', passengerId: PAX }),
    );
    const recs = [...store.records.values()];
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.channel).toBe(NotificationChannel.PUSH);
    expect(rec.template).toBe(TEMPLATE_KEYS.TRIP_CHILD_CODE_FAILED);
    expect(rec.recipientId).toBe(PAX);
    expect(rec.priority).toBe(NotificationPriority.Critical); // seguridad infantil: drena antes que todo
    expect(rec.payload.to).toBe('tok-K');
    expect(rec.payload.data).toEqual({ tripId: 'trip-K', screen: 'TripActive' });
  });

  it('sin passengerId enriquecido (gap de contrato) → degrada honesto (no encola)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-K', platform: 'android' }] });
    await registered.get('trip.child_code_failed')!(
      env('trip.child_code_failed', { tripId: 'trip-K', attempt: 1, at: '2026-06-10T00:00:00Z' }),
    );
    expect(store.records.size).toBe(0);
  });

  it('sin token push del pasajero (evento ni almacén) → degrada honesto (no encola)', async () => {
    const { store } = await buildAndInit({});
    await registered.get('trip.child_code_failed')!(
      env('trip.child_code_failed', { tripId: 'trip-K', attempt: 1, at: '2026-06-10T00:00:00Z', passengerId: PAX }),
    );
    expect(store.records.size).toBe(0);
  });

  it('redelivery del MISMO evento → no duplica la alerta (dedup por eventId)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-K', platform: 'android' }] });
    const e = env('trip.child_code_failed', { tripId: 'trip-K', attempt: 1, at: '2026-06-10T00:00:00Z', passengerId: PAX });
    await registered.get('trip.child_code_failed')!(e);
    await registered.get('trip.child_code_failed')!(e);
    expect(store.records.size).toBe(1);
  });

  it('un intento NUEVO (otro evento, mismo viaje) → SÍ vuelve a alertar (cada intento cuenta)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-K', platform: 'android' }] });
    await registered.get('trip.child_code_failed')!(
      env('trip.child_code_failed', { tripId: 'trip-K', attempt: 1, at: '2026-06-10T00:00:00Z', passengerId: PAX }),
    );
    await registered.get('trip.child_code_failed')!(
      env('trip.child_code_failed', { tripId: 'trip-K', attempt: 2, at: '2026-06-10T00:01:00Z', passengerId: PAX }),
    );
    expect(store.records.size).toBe(2);
  });
});

describe('EventConsumerService · chat.message_sent (sin presencia, push al pasajero)', () => {
  beforeEach(() => registered.clear());

  it('mensaje del CONDUCTOR con passengerId → push al pasajero (preview), dedup por messageId', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-M', platform: 'android' }] });
    await registered.get('chat.message_sent')!(
      env('chat.message_sent', {
        messageId: 'msg-1', tripId: 'trip-1', senderId: 'drv-1', senderRole: 'DRIVER', body: 'Ya llegué', createdAt: 'x', passengerId: PAX,
      }),
    );
    const rec = [...store.records.values()][0]!;
    expect(rec.template).toBe(TEMPLATE_KEYS.CHAT_MESSAGE);
    expect(rec.payload.vars).toMatchObject({ preview: 'Ya llegué' });
    expect(rec.recipientId).toBe(PAX);
  });

  it('mensaje del PASAJERO → no pushea (destinatario sería el conductor: decisión pendiente)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-M', platform: 'android' }] });
    await registered.get('chat.message_sent')!(
      env('chat.message_sent', { messageId: 'msg-2', tripId: 't', senderId: PAX, senderRole: 'PASSENGER', body: 'voy', createdAt: 'x', passengerId: PAX }),
    );
    expect(store.records.size).toBe(0);
  });

  it('mensaje del conductor SIN passengerId enriquecido → degrada', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-M', platform: 'android' }] });
    await registered.get('chat.message_sent')!(
      env('chat.message_sent', { messageId: 'msg-3', tripId: 't', senderId: 'd', senderRole: 'DRIVER', body: 'hola', createdAt: 'x' }),
    );
    expect(store.records.size).toBe(0);
  });

  it('redelivery del mismo mensaje → no duplica (dedup por messageId)', async () => {
    const { store } = await buildAndInit({ [PAX]: [{ token: 'tok-M', platform: 'android' }] });
    const e = env('chat.message_sent', { messageId: 'msg-1', tripId: 't', senderId: 'd', senderRole: 'DRIVER', body: 'hola', createdAt: 'x', passengerId: PAX });
    await registered.get('chat.message_sent')!(e);
    await registered.get('chat.message_sent')!(e);
    expect(store.records.size).toBe(1);
  });
});
