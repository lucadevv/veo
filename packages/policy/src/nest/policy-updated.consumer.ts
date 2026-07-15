/**
 * PolicyUpdatedConsumer — consumer Kafka del evento `policy.updated` (ADR-024 §2). Mantiene fresco el cache
 * del `KafkaCachedPolicyReader`: ante cada cambio del superadmin, actualiza la key afectada SIN esperar TTL.
 *
 * Reusa la infra estándar de consumers del monorepo (`KafkaConsumerBootstrap` de `@veo/events/nest`): createKafka
 * + KafkaEventConsumer + lifecycle + backoff de arranque. Regla de oro: un groupId = UN consumer con TODOS sus
 * eventos en `handlers()`. Este consumer suscribe SOLO `policy.updated` con SU propio groupId (`${service}-policy`),
 * aislado de los demás consumers del servicio para que el broadcast llegue a cada instancia de enforcement.
 */
import { Injectable } from '@nestjs/common';
import { EVENT_SCHEMAS, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap, type KafkaConsumerBootstrapOptions } from '@veo/events/nest';
import { KafkaCachedPolicyReader } from './kafka-cached-policy-reader.js';

const POLICY_UPDATED = 'policy.updated' as const;

@Injectable()
export class PolicyUpdatedConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly reader: KafkaCachedPolicyReader,
    options: KafkaConsumerBootstrapOptions,
  ) {
    super(options);
  }

  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      [POLICY_UPDATED]: async (envelope) => {
        // KafkaEventConsumer ya valida el payload contra el registro antes del handler; re-parseamos para
        // obtener el dato TIPADO (defensa en profundidad, mismo patrón que audit.consumer).
        const parsed = EVENT_SCHEMAS[POLICY_UPDATED].safeParse(envelope.payload);
        if (!parsed.success) {
          this.logger.warn(
            `${POLICY_UPDATED} con payload inválido (eventId=${envelope.eventId}); ignorado`,
          );
          return;
        }
        this.reader.applyEvent(parsed.data);
      },
    };
  }

  protected override subscriptionLog(): string {
    return 'Suscrito a policy.updated (frescura del cache de @veo/policy)';
  }
}
