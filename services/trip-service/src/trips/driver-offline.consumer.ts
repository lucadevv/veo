/**
 * Fase B (ADR-021 · finding B1 · B-react) — Consumidor Kafka de `driver.went_offline` → REASIGNA el viaje
 * PRE-RECOJO del conductor que se fue offline.
 *
 * EL FIX del "pasajero abandonado sin re-match": hasta hoy, si el conductor ganaba un viaje y luego cerraba
 * la app / perdía conexión SIN cancelar explícitamente, NADA reaccionaba — el pasajero esperaba hasta que el
 * watchdog pre-recojo (~15min) EXPIRABA el viaje (sin reasignar). El cancel EXPLÍCITO ya reasignaba
 * (`reassignAfterDriverCancel` → REASSIGNING → re-abre el board); el offline silencioso no. Este consumer lo
 * cierra: enruta el viaje del conductor offline hacia la MISMA máquina de reasignación (sin duplicarla).
 *
 * `driver.went_offline` viaja en el topic 'driver' (ciclo de vida). Group PROPIO (`trip-service.driver-offline`,
 * no comparte el del match ni el de PUJA ni el de erasure): regla de oro un groupId = UN consumer con TODOS
 * sus eventos. dispatch consume el MISMO evento en su propio group para retirar ofertas + evictar del pool.
 *
 * IDEMPOTENTE + FAIL-SAFE: `reassignForDriverOffline` es no-op si el conductor no tiene un viaje pre-recojo
 * (POST_ACCEPT). Un error TRANSITORIO (DB caída) se relanza para que kafkajs reintente (la reasignación es
 * idempotente por el estado); el logueo cubre el diagnóstico. El BOOTSTRAP vive en KafkaConsumerBootstrap.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_SCHEMAS, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { TripsService } from './trips.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este consumer (también su groupId, propio). */
const KAFKA_CLIENT_ID = 'trip-service-driver-offline';
const GROUP_ID = 'trip-service.driver-offline';

@Injectable()
export class DriverOfflineConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). Topic 'driver'. */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { 'driver.went_offline': (env) => this.onDriverWentOffline(env) };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (reasignación pre-recojo por offline)`;
  }

  private async onDriverWentOffline(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['driver.went_offline'].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn('driver.went_offline con payload inválido; ignorado');
      return;
    }
    try {
      await this.trips.reassignForDriverOffline(parsed.data.driverId);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs (la reasignación es idempotente por estado). Log para diagnóstico.
      this.logger.error(
        { err, driverId: parsed.data.driverId },
        'No se pudo reasignar el viaje del conductor offline',
      );
      throw err;
    }
  }
}
