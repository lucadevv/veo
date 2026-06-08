/**
 * HARDENING (incidente dev 2026-06): poison messages se LOGUEAN y SALTAN; errores transitorios
 * SIGUEN reintentando. Un `trip.completed` con `tripId` NO-UUID envenenaba el topic `trip`:
 * zod pasa (tripId es z.string()) → chargeFromTripCompleted toca columna `trip_id @db.Uuid` →
 * Prisma P2023 → el catch RELANZABA SIEMPRE → kafkajs reintenta 5 → crash → restart → MISMO
 * offset → loop infinito, partición bloqueada.
 *
 * Verifica el handler onTripCompleted SIN Kafka real:
 *  1. tripId no-UUID  → NO relanza (poison: log & skip), NO intenta cobrar.
 *  2. tripId válido   → cobra normalmente (chargeFromTripCompleted).
 *  3. error transitorio (DB caída) → SÍ relanza (reintento de Kafka).
 *  4. error permanente (P2023 desde DB, defensa en profundidad) → NO relanza.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope } from '@veo/events';
import type * as VeoEvents from '@veo/events';
import { PaymentEventConsumers } from './consumers';
import type { PaymentsService } from '../payments/payments.service';
import type { PayoutsService } from '../payouts/payouts.service';
import type { IncentivesService } from '../incentives/incentives.service';

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
      fire(eventType: string, env: unknown) {
        return this.fake.handlers.get(eventType)?.(env);
      }
    },
  };
});

const config = {
  getOrThrow: (k: string): string => (k === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
} as never;

const VALID_TRIP_ID = '018f9a3e-1c2b-7d4e-8a1f-0123456789ab';
const VALID_DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-aaaaaaaaaaaa';

function build(charge: ReturnType<typeof vi.fn>): {
  svc: PaymentEventConsumers;
  creditTrip: ReturnType<typeof vi.fn>;
} {
  const payments = { chargeFromTripCompleted: charge } as unknown as PaymentsService;
  const payouts = { holdDriver: vi.fn(async () => {}) } as unknown as PayoutsService;
  const creditTrip = vi.fn(async () => {});
  const incentives = { creditTrip } as unknown as IncentivesService;
  const svc = new PaymentEventConsumers(payments, payouts, incentives, config);
  return { svc, creditTrip };
}

function fire(svc: PaymentEventConsumers, tripId: string) {
  const consumer = (svc as unknown as { consumer: { fire: (t: string, e: unknown) => Promise<void> } })
    .consumer;
  const env = createEnvelope({
    eventType: 'trip.completed',
    producer: 'trip-service',
    payload: {
      tripId,
      fareCents: 1500,
      distanceMeters: 4200,
      durationSeconds: 600,
      driverId: VALID_DRIVER_ID,
      paymentMethod: 'CASH',
    },
  });
  return consumer.fire('trip.completed', env);
}

describe('PaymentEventConsumers · trip.completed hardening (poison vs transitorio)', () => {
  it('tripId NO-UUID → NO relanza (log & skip) y NO intenta cobrar', async () => {
    const charge = vi.fn(async () => ({ id: 'pay-1', status: 'PENDING' }));
    const { svc } = build(charge);
    await svc.onModuleInit();
    // El veneno exacto del incidente.
    await expect(fire(svc, 'NOT-A-UUID')).resolves.toBeUndefined();
    expect(charge).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('tripId válido → cobra normalmente (chargeFromTripCompleted)', async () => {
    const charge = vi.fn(async () => ({ id: 'pay-1', status: 'PENDING' }));
    const { svc } = build(charge);
    await svc.onModuleInit();
    await fire(svc, VALID_TRIP_ID);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({ tripId: VALID_TRIP_ID, method: 'CASH' }),
    );
    await svc.onModuleDestroy();
  });

  it('error TRANSITORIO (DB caída) con tripId válido → SÍ relanza (Kafka reintenta)', async () => {
    const transient = Object.assign(new Error('connection refused'), { code: 'P1001' });
    const charge = vi.fn(async () => {
      throw transient;
    });
    const { svc } = build(charge);
    await svc.onModuleInit();
    await expect(fire(svc, VALID_TRIP_ID)).rejects.toBe(transient);
    await svc.onModuleDestroy();
  });

  it('error PERMANENTE de datos (P2023 desde DB) con tripId válido → NO relanza (defensa en profundidad)', async () => {
    const poison = Object.assign(new Error('inconsistent column data'), { code: 'P2023' });
    const charge = vi.fn(async () => {
      throw poison;
    });
    const { svc } = build(charge);
    await svc.onModuleInit();
    await expect(fire(svc, VALID_TRIP_ID)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });
});
