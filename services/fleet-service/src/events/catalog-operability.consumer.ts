/**
 * CatalogOperabilityConsumer — consume `catalog.updated` (trip-service, dueño del catálogo) y cierra el SEAM
 * catálogo↔operabilidad (ADR 013): cuando el admin desactiva/re-activa una CLASE de vehículo en el catálogo,
 * suspende/reincorpora a los conductores de esa clase (ver CatalogOperabilityService para la lógica y las
 * decisiones — autoritativo-desde-el-payload, delta, idempotencia monotónica).
 *
 * REGLA DE ORO (@veo/events/nest): un groupId = UN consumer con TODOS sus eventos. Este es el SEGUNDO consumer de
 * fleet (el otro es ErasureConsumer, groupId `fleet-service.erasure`), con su PROPIO groupId DEDICADO
 * `fleet-service.catalog-operability` → su offset/rebalanceo no se acopla al de erasure, y no viola la regla de oro
 * (dos consumers del MISMO groupId en topics distintos es lo prohibido; groupIds distintos es correcto). El topic
 * de `catalog.updated` lo resuelve `topicForEvent` → 'catalog'.
 *
 * El payload YA lo valida el KafkaEventConsumer contra el registro central (`catalog.updated` quedó registrado);
 * igual re-parseamos con el zod `catalogUpdated` (defensa en profundidad + extracción tipada), como hace el
 * consumer de suspensión de identity.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { catalogUpdated, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { CatalogOperabilityService } from './catalog-operability.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'fleet-service';

/** Group DEDICADO del seam catálogo↔operabilidad (no comparte el de erasure). */
const CATALOG_OPERABILITY_GROUP_ID = 'fleet-service.catalog-operability';

const CATALOG_UPDATED = 'catalog.updated';

@Injectable()
export class CatalogOperabilityConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly service: CatalogOperabilityService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: CATALOG_OPERABILITY_GROUP_ID,
    });
  }

  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { [CATALOG_UPDATED]: (env) => this.onCatalogUpdated(env) };
  }

  protected override subscriptionLog(): string {
    return `Suscrito a ${CATALOG_UPDATED} (seam catálogo↔operabilidad: suspende/reincorpora por clase de vehículo)`;
  }

  private async onCatalogUpdated(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = catalogUpdated.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${CATALOG_UPDATED} con payload inválido (eventId=${env.eventId}); descartado`);
      return;
    }
    try {
      const result = await this.service.applyCatalogUpdate(parsed.data);
      if (result.skipped) {
        this.logger.debug(`${CATALOG_UPDATED} v${parsed.data.version} stale (≤ aplicada); ignorado`);
        return;
      }
      if (result.suspended > 0 || result.reactivated > 0) {
        this.logger.log(
          `catálogo v${result.version}: apagadas [${result.disabledClasses.join(',')}] → ` +
            `${result.suspended} conductor(es) suspendido(s); encendidas [${result.enabledClasses.join(',')}] → ` +
            `${result.reactivated} reincorporado(s)`,
        );
      } else {
        this.logger.debug(`${CATALOG_UPDATED} v${result.version} sin cambios de clase; ningún hold tocado`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló el procesamiento de ${CATALOG_UPDATED} (eventId=${env.eventId})`);
      throw err; // que Kafka reintente; applyCatalogUpdate es idempotente (guard monotónico + holds unique).
    }
  }
}
