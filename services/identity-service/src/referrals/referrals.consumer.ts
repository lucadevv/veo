/**
 * Consumidor Kafka de identity para referidos (Ola 2A).
 *  - trip.completed → si el pasajero fue referido y el vínculo está PENDING, otorga la recompensa
 *    al referidor (idempotente: solo el primer viaje completado dispara el reward).
 * El payload se valida contra EVENT_SCHEMAS antes de procesarse.
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
import { ReferralsService } from './referrals.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class ReferralsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReferralsConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly referrals: ReferralsService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'identity-service-referrals',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'identity-service-referrals',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'identity-service-referrals');
    this.consumer.on('trip.completed', (env) => this.onTripCompleted(env));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Consumidor de referidos iniciado (trip.completed)');
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
    const { passengerId, tripId } = parsed.data;
    if (!passengerId) return; // sin pasajero no podemos resolver el referido
    // HARDENING (incidente dev 2026-06): zod deja pasar `passengerId` no-UUID (es `z.string()`, no
    // `.uuid()` — endurecer el schema compartido afecta a TODOS los producers/consumers). Pero
    // `rewardReferralForTrip` consulta `Referral.referredUserId` que es `@db.Uuid`: un id malformado
    // (p.ej. 'smoke-...') → Prisma P2023 → el catch RELANZABA SIEMPRE → kafkajs reintenta → crash →
    // restart → MISMO offset → loop infinito, partición del group de identity bloqueada. Guardamos el
    // borde ANTES de tocar Prisma: passengerId no-UUID es VENENO → log ERROR + RETURN (el offset avanza).
    if (!isUuid(passengerId)) {
      this.logger.error(
        `POISON trip.completed: passengerId no-UUID "${passengerId}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      return;
    }
    try {
      await this.referrals.rewardReferralForTrip(passengerId, tripId);
    } catch (err) {
      // Red de seguridad: distinguir VENENO de TRANSITORIO. Un error permanente de datos
      // (P2023/P2009/P2000…) NUNCA va a procesar → log ERROR + saltar (NO relanzar). Lo transitorio
      // (DB caída, deadlock, timeout) SÍ se relanza para reintentar; rewardReferralForTrip es idempotente.
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON trip.completed: error permanente de datos en recompensa de referido para viaje ${tripId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        return;
      }
      this.logger.error({ err }, `Falló la recompensa de referido para el viaje ${tripId}`);
      throw err; // que Kafka reintente; rewardReferralForTrip es idempotente.
    }
  }
}
