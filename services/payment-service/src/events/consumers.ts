/**
 * Consumidores Kafka del payment-service.
 *  - trip.completed → dispara el cobro del viaje (BR-P01), idempotente por dedupKey determinista.
 *  - driver.flagged → retiene los payouts del conductor en review (BR-P05).
 * Los payloads se validan contra EVENT_SCHEMAS antes de procesarlos.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  EVENT_SCHEMAS,
  isPermanentDataError,
  isUuid,
  type EventEnvelope,
} from '@veo/events';
import { PaymentsService } from '../payments/payments.service';
import { deriveTripChargeDedupKey } from '../payments/payment.policy';
import { PayoutsService } from '../payouts/payouts.service';
import { IncentivesService } from '../incentives/incentives.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class PaymentEventConsumers implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventConsumers.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly incentives: IncentivesService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'payment-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'payment-service',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'payment-service');
    this.consumer.on('trip.completed', (env) => this.onTripCompleted(env));
    this.consumer.on('driver.flagged', (env) => this.onDriverFlagged(env));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Consumidores Kafka iniciados (trip.completed, driver.flagged)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onTripCompleted(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['trip.completed'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('trip.completed con payload inválido; descartado');
      return;
    }
    const { tripId, fareCents, driverId, passengerId, promoCode, paymentMethod, cashCollected } =
      parsed.data;
    // HARDENING (incidente dev 2026-06): zod deja pasar `tripId` no-UUID (es `z.string()`, no
    // `.uuid()` — endurecer el schema compartido afecta a TODOS los producers/consumers). Pero la
    // columna `trip_id` es `@db.Uuid`: un id malformado → Prisma P2023 → el catch RELANZABA SIEMPRE →
    // kafkajs reintenta 5 → crash → restart → MISMO offset → loop infinito, partición bloqueada.
    // Guardamos el borde: tripId no-UUID es VENENO → log ERROR + RETURN (saltar, el offset avanza).
    if (!isUuid(tripId)) {
      this.logger.error(
        `POISON trip.completed: tripId no-UUID "${tripId}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      const payment = await this.payments.chargeFromTripCompleted({
        tripId,
        grossCents: fareCents,
        dedupKey: deriveTripChargeDedupKey(tripId),
        driverId,
        // Método del VIAJE (CASH/YAPE/PLIN/CARD): el cobro respeta lo que eligió el pasajero.
        // Si el evento es viejo y no lo trae, chargeFromTripCompleted cae al default del env.
        method: paymentMethod,
        promoCode,
        userId: passengerId,
        // EFECTIVO (decisión del dueño): el conductor cobró en mano al terminar (driverConfirmed). Solo
        // significativo si method=CASH; chargeFromTripCompleted crea la CashConfirmation driverConfirmed=true
        // y emite payment.cash_pending (push al pasajero para que confirme). Ausente/false ⇒ bilateral normal.
        cashCollected,
      });
      this.logger.log(`Cobro de viaje ${tripId}: pago ${payment.id} estado ${payment.status}`);
    } catch (err) {
      // Red de seguridad: distinguir VENENO de TRANSITORIO. Un error permanente de datos
      // (P2023/P2009/P2000…) NUNCA va a procesar → log ERROR + saltar (NO relanzar). Lo transitorio
      // (DB caída, deadlock, timeout) SÍ se relanza para reintentar; el cobro es idempotente.
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.completed: error permanente de datos al cobrar viaje ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló el cobro del viaje ${tripId}`);
      throw err; // que Kafka reintregue/reintente; el cobro es idempotente.
    }

    // Ola 2C · incentivos: acredita el viaje a los META_VIAJES vigentes del conductor (idempotente
    // por viaje). Independiente del cobro: si falla, no debe revertir el pago ya capturado.
    if (driverId) {
      try {
        await this.incentives.creditTrip(driverId, tripId);
      } catch (err) {
        this.logger.error({ err }, `Falló acreditar incentivos del viaje ${tripId}`);
      }
    }
  }

  private async onDriverFlagged(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['driver.flagged'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('driver.flagged con payload inválido; descartado');
      return;
    }
    await this.payouts.holdDriver(parsed.data.driverId);
    this.logger.log(`Conductor ${parsed.data.driverId} marcado para retención de payouts`);
  }
}
