/**
 * PricingCacheConsumer (booking-service · F2.5) — invalidación INSTANTÁNEA cross-réplica del cache del
 * costo/km vivo. CostPerKmService cachea (un slot, TTL corto) el costo/km PE derivado del precio de energía
 * de trip-service. Cuando el admin EDITA el EnergyCatalog, trip-service emite `energy.catalog_updated`; este
 * consumer lo escucha y llama `CostPerKmService.invalidateCache()` en CADA réplica → el nuevo precio se
 * refleja en el tope legal de inmediato, sin esperar el TTL (que queda de fallback ante un evento perdido).
 *
 * Es el ESPEJO del PricingCacheConsumer de trip-service (mismo evento, misma reacción cache=null), pero para
 * el cache PROPIO de booking. groupId DEDICADO `booking-service.pricing-cache` (no comparte el del cobro
 * async `booking-service.payment`): su offset/rebalanceo no se acoplan a ese flujo.
 *
 * REGLA DE ORO (@veo/events/nest): un groupId = UN consumer con TODOS sus eventos en `handlers()`. Acá hay
 * un solo evento, pero el contrato se respeta (un único record). Invalidar es idempotente y barato (cache =
 * null): una redelivery at-least-once solo re-vacía un cache ya vacío. NO lanza, NO valida payload (la
 * próxima lectura repuebla del endpoint), NO hay nada que mandar a DLQ.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope, EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { CostPerKmService } from './cost-per-km.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio (ADR-014: brokers de KAFKA_BROKERS). */
const KAFKA_CLIENT_ID = 'booking-service';

/** Group DEDICADO de la invalidación de cache (no comparte el de cobro async `booking-service.payment`). */
const PRICING_CACHE_GROUP_ID = 'booking-service.pricing-cache';

/** Evento que invalida el cache del costo/km vivo: el PUT del EnergyCatalog de trip-service. */
const ENERGY_CATALOG_UPDATED = 'energy.catalog_updated' as const;

@Injectable()
export class PricingCacheConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly costPerKm: CostPerKmService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: PRICING_CACHE_GROUP_ID,
    });
  }

  /** Todos los eventos del group, en un solo record (único punto de registro · regla de oro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      [ENERGY_CATALOG_UPDATED]: (envelope) => this.onEnergyCatalogUpdated(envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (invalidación del cache de costo/km del cost-cap · F2.5)`;
  }

  /**
   * `energy.catalog_updated` → invalida el cache del costo/km vivo. Idempotente y barato (cache = null): NO
   * relee nada, NO valida payload (la próxima lectura del gate repuebla del endpoint). No lanza.
   */
  private onEnergyCatalogUpdated(envelope: EventEnvelope<unknown>): Promise<void> {
    this.costPerKm.invalidateCache();
    this.logger.debug(
      `${ENERGY_CATALOG_UPDATED} (eventId=${envelope.eventId}) → cache de costo/km invalidado`,
    );
    return Promise.resolve();
  }
}
