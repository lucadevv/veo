/**
 * HARDENING (incidente dev 2026-06): poison messages se LOGUEAN y SALTAN; errores transitorios
 * SIGUEN reintentando. Un `trip.completed` con `passengerId` NO-UUID (p.ej. 'smoke-...') envenenaba
 * el group de identity: zod pasa (passengerId es z.string()) → rewardReferralForTrip consulta
 * `Referral.referredUserId @db.Uuid` → Prisma P2023 → el catch RELANZABA SIEMPRE → kafkajs reintenta
 * → crash → restart → MISMO offset → loop infinito, partición del group de identity bloqueada.
 *
 * Verifica el handler onTripCompleted SIN Kafka real:
 *  1. passengerId no-UUID → NO relanza (poison: log & skip), NO intenta recompensar.
 *  2. passengerId válido  → recompensa normalmente (rewardReferralForTrip).
 *  3. error transitorio (DB caída) → SÍ relanza (reintento de Kafka).
 *  4. error permanente (P2023 desde DB, defensa en profundidad) → NO relanza.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope } from '@veo/events';
import type * as VeoEvents from '@veo/events';
import { ReferralsConsumer } from './referrals.consumer';
import type { ReferralsService } from './referrals.service';

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
const VALID_PASSENGER_ID = '018f9a3e-1c2b-7d4e-8a1f-bbbbbbbbbbbb';

function build(reward: ReturnType<typeof vi.fn>): ReferralsConsumer {
  const referrals = { rewardReferralForTrip: reward } as unknown as ReferralsService;
  return new ReferralsConsumer(referrals, config);
}

function fire(svc: ReferralsConsumer, passengerId: string) {
  const consumer = (svc as unknown as { consumer: { fire: (t: string, e: unknown) => Promise<void> } })
    .consumer;
  const env = createEnvelope({
    eventType: 'trip.completed',
    producer: 'trip-service',
    payload: {
      tripId: VALID_TRIP_ID,
      fareCents: 1500,
      distanceMeters: 4200,
      durationSeconds: 600,
      passengerId,
      paymentMethod: 'CASH',
    },
  });
  return consumer.fire('trip.completed', env);
}

describe('ReferralsConsumer · trip.completed hardening (poison vs transitorio)', () => {
  it('passengerId NO-UUID → NO relanza (log & skip) y NO intenta recompensar', async () => {
    const reward = vi.fn(async () => {});
    const svc = build(reward);
    await svc.onModuleInit();
    // El veneno exacto del incidente: un passengerId no-UUID de un smoke test viejo.
    await expect(fire(svc, 'smoke-passenger-123')).resolves.toBeUndefined();
    expect(reward).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('passengerId válido → recompensa normalmente (rewardReferralForTrip)', async () => {
    const reward = vi.fn(async () => {});
    const svc = build(reward);
    await svc.onModuleInit();
    await fire(svc, VALID_PASSENGER_ID);
    expect(reward).toHaveBeenCalledTimes(1);
    expect(reward).toHaveBeenCalledWith(VALID_PASSENGER_ID, VALID_TRIP_ID);
    await svc.onModuleDestroy();
  });

  it('error TRANSITORIO (DB caída) con passengerId válido → SÍ relanza (Kafka reintenta)', async () => {
    const transient = Object.assign(new Error('connection refused'), { code: 'P1001' });
    const reward = vi.fn(async () => {
      throw transient;
    });
    const svc = build(reward);
    await svc.onModuleInit();
    await expect(fire(svc, VALID_PASSENGER_ID)).rejects.toBe(transient);
    await svc.onModuleDestroy();
  });

  it('error PERMANENTE de datos (P2023 desde DB) con passengerId válido → NO relanza (defensa en profundidad)', async () => {
    const poison = Object.assign(new Error('inconsistent column data'), { code: 'P2023' });
    const reward = vi.fn(async () => {
      throw poison;
    });
    const svc = build(reward);
    await svc.onModuleInit();
    await expect(fire(svc, VALID_PASSENGER_ID)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });
});
