/**
 * CommissionCacheConsumer — invalidación INSTANTÁNEA cross-réplica del cache de la comisión (F2.7). Espeja
 * PricingCacheConsumer de trip-service: el PUT de la comisión emite `payment.commission_updated` por outbox e
 * invalida SU cache local; este consumer escucha el evento y llama `invalidateCache()` en CADA réplica que lo
 * recibe → el cambio se ve de inmediato en todas, sin esperar el TTL (que queda como fallback).
 *
 * groupId DEDICADO `payment-service.commission-cache`: independiente del consumer PRINCIPAL (`payment-service`,
 * que es LOAD-BALANCED para cobros/refunds) — acá NO queremos balanceo, queremos que cada réplica invalide su
 * propio cache. La invalidación es idempotente y barata (`cache = null`); una redelivery solo vuelve a vaciar un
 * cache ya vacío. No lanza: invalidar no puede fallar.
 *
 * REGLA DE ORO (@veo/events/nest): un groupId = UN consumer con TODOS sus eventos en `handlers()`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope, EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import type { Env } from '../config/env.schema';
import { CommissionService } from './commission.service';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'payment-service';

/** Group DEDICADO de la invalidación de cache de comisión (no comparte el principal load-balanced). */
const COMMISSION_CACHE_GROUP_ID = 'payment-service.commission-cache';

@Injectable()
export class CommissionCacheConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly commission: CommissionService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: COMMISSION_CACHE_GROUP_ID,
    });
  }

  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'payment.commission_updated': (envelope) => this.onCommissionUpdated(envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (invalidación de cache de comisión cross-réplica)`;
  }

  /**
   * Invalida el cache de la comisión. Idempotente y barato (un `cache = null`): NO relee la DB ni valida
   * payload — la próxima lectura repuebla del repo. No lanza: invalidar no puede fallar.
   */
  private async onCommissionUpdated(envelope: EventEnvelope<unknown>): Promise<void> {
    this.commission.invalidateCache();
    this.logger.debug(
      `payment.commission_updated (eventId=${envelope.eventId}) → cache de comisión invalidado`,
    );
    return Promise.resolve();
  }
}
