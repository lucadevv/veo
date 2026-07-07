/**
 * PricingCacheConsumer — invalidación INSTANTÁNEA cross-réplica del cache de config de pricing.
 *
 * El problema (cerrado por este consumer): los servicios de config editable en caliente
 * (PricingScheduleService, BidFloorService, BaseFareService, CatalogService) cachean
 * en-proceso con TTL corto y, en el PUT, EMITEN un evento por outbox + invalidan SU cache local.
 * Pero el evento NO lo consumía nadie → en multi-réplica el PUT solo refresca la réplica que lo
 * atendió; las DEMÁS servían config STALE hasta que venciera su TTL (≤ cacheTtlMs).
 *
 * Este consumer escucha esos mismos eventos y llama `invalidateCache()` del servicio dueño en
 * CADA réplica que recibe el evento → el cambio se ve de inmediato en TODAS, sin esperar el TTL
 * (que queda como fallback ante un evento perdido). NO toca la lógica del cache ni el TTL: solo
 * añade el disparador de invalidación que faltaba.
 *
 * REGLA DE ORO (@veo/events/nest): un groupId = UN consumer con TODOS sus eventos en `handlers()`.
 * Los 4 eventos viven en topics distintos (pricing / fuel / energy / catalog, derivados por
 * `topicForEvent` del dominio antes del punto); todos entran en este único record → el bug de
 * particiones sin asignar (dos consumers, mismo groupId, topics distintos) es imposible.
 *
 * groupId DEDICADO `trip-service.pricing-cache`: independiente del de puja/dispatch/erasure para
 * que su offset y su rebalanceo no se acoplen a esos flujos.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope, EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import type { Env } from '../config/env.schema';
import { CatalogService } from '../catalog/catalog.service';
import { PricingScheduleService } from './pricing-schedule.service';
import { BidFloorService } from './bid-floor.service';
import { BaseFareService } from './base-fare.service';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'trip-service';

/** Group DEDICADO de la invalidación de cache (no comparte el de puja/dispatch/erasure). */
const PRICING_CACHE_GROUP_ID = 'trip-service.pricing-cache';

/**
 * Los eventType que invalidan cada cache. Son las CLAVES del registro central de @veo/events
 * (`pricing.mode_schedule_updated` está tipado en EVENT_SCHEMAS; los otros tres son eventos de
 * outbox del dominio de pricing, mismas claves que emite cada `replace*`). Tabla declarativa para
 * que añadir un evento sea una fila (sin tocar el bootstrap).
 */
const PRICING_CACHE_EVENTS = {
  'pricing.mode_schedule_updated': 'schedule',
  'pricing.bid_floor_updated': 'bid_floor',
  'pricing.base_fare_updated': 'base_fare',
  'catalog.updated': 'catalog',
} as const;

type PricingCacheEvent = keyof typeof PRICING_CACHE_EVENTS;

@Injectable()
export class PricingCacheConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly schedule: PricingScheduleService,
    private readonly catalog: CatalogService,
    private readonly bidFloor: BidFloorService,
    private readonly baseFare: BaseFareService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: PRICING_CACHE_GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro · regla de oro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'pricing.mode_schedule_updated': (envelope) =>
        this.onConfigUpdated('pricing.mode_schedule_updated', envelope),
      'pricing.bid_floor_updated': (envelope) =>
        this.onConfigUpdated('pricing.bid_floor_updated', envelope),
      'pricing.base_fare_updated': (envelope) =>
        this.onConfigUpdated('pricing.base_fare_updated', envelope),
      'catalog.updated': (envelope) => this.onConfigUpdated('catalog.updated', envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (invalidación de cache de pricing cross-réplica)`;
  }

  /**
   * Invalida el cache del servicio dueño del `eventType`. Idempotente y barato (un `cache = null`):
   * NO relee la DB ni valida payload — la próxima lectura repuebla del repo. Una redelivery de Kafka
   * (at-least-once) solo vuelve a invalidar un cache ya vacío → inofensivo. No lanza: invalidar no
   * puede fallar, así que no hay nada que reintentar ni que mandar a DLQ.
   */
  private async onConfigUpdated(
    eventType: PricingCacheEvent,
    envelope: EventEnvelope<unknown>,
  ): Promise<void> {
    switch (eventType) {
      case 'pricing.mode_schedule_updated':
        this.schedule.invalidateCache();
        break;
      case 'pricing.bid_floor_updated':
        this.bidFloor.invalidateCache();
        break;
      case 'pricing.base_fare_updated':
        this.baseFare.invalidateCache();
        break;
      case 'catalog.updated':
        this.catalog.invalidateCache();
        break;
    }
    this.logger.debug(
      `${eventType} (eventId=${envelope.eventId}) → cache de ${PRICING_CACHE_EVENTS[eventType]} invalidado`,
    );
    return Promise.resolve();
  }
}
