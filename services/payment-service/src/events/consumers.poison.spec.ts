/**
 * HARDENING (incidente dev 2026-06): poison messages se LOGUEAN y SALTAN; errores transitorios
 * SIGUEN reintentando. Un `trip.completed` con `tripId` NO-UUID envenenaba el topic `trip`:
 * zod pasa (tripId es z.string()) → settleTripFareOnCompletion toca columna `trip_id @db.Uuid` →
 * Prisma P2023 → el catch RELANZABA SIEMPRE → kafkajs reintenta 5 → crash → restart → MISMO
 * offset → loop infinito, partición bloqueada.
 *
 * Verifica el handler onTripCompleted SIN Kafka real (espía sobre el KafkaEventConsumer real,
 * con start/stop anulados — los handlers los registra el bootstrap promovido de @veo/events/nest
 * en onModuleInit):
 *  1. tripId no-UUID  → NO relanza (poison: log & skip), NO intenta cobrar.
 *  2. tripId válido   → cobra normalmente (settleTripFareOnCompletion).
 *  3. error transitorio (DB caída) → SÍ relanza (reintento de Kafka).
 *  4. error permanente (P2023 desde DB, defensa en profundidad) → NO relanza.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { PaymentEventConsumers } from './consumers';
import type { PaymentsService } from '../payments/payments.service';
import type { PayoutsService } from '../payouts/payouts.service';
import type { CreditService } from '../credit/credit.service';
import type { IncentivesService } from '../incentives/incentives.service';

// Captura los handlers que el bootstrap registra con .on() para dispararlos a mano (sin Kafka real).
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

const VALID_TRIP_ID = '018f9a3e-1c2b-7d4e-8a1f-0123456789ab';
const VALID_DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-aaaaaaaaaaaa';

function build(charge: ReturnType<typeof vi.fn>): {
  svc: PaymentEventConsumers;
  creditTrip: ReturnType<typeof vi.fn>;
} {
  const payments = { settleTripFareOnCompletion: charge } as unknown as PaymentsService;
  const payouts = { holdDriver: vi.fn(async () => {}) } as unknown as PayoutsService;
  const creditTrip = vi.fn(async () => {});
  const incentives = { creditTrip } as unknown as IncentivesService;
  const credit = { creditFromReferral: vi.fn(async () => true) } as unknown as CreditService;
  // Redis solo lo usa onBookingCancelled (no ejercitado acá): dedup que nunca marca → siempre ejecuta.
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } as never;
  const metrics = {
    incRefundBackstop: vi.fn(),
  } as unknown as import('../metrics/payment.metrics').PaymentMetrics;
  const svc = new PaymentEventConsumers(
    payments,
    payouts,
    incentives,
    credit,
    redis,
    metrics,
    config,
  );
  return { svc, creditTrip };
}

function fire(_svc: PaymentEventConsumers, tripId: string) {
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
  return handlers.get('trip.completed')?.(env);
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

  it('tripId válido → cobra normalmente (settleTripFareOnCompletion)', async () => {
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
