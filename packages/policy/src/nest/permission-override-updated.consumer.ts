/**
 * PermissionOverrideUpdatedConsumer — consumer Kafka del evento `permission_override.updated` (ADR-025 §3).
 * Mantiene fresco el OVERLAY del `KafkaCachedPolicyReader`: ante cada RESTA/des-resta del superadmin, actualiza
 * el par `(role, permission)` afectado SIN esperar TTL.
 *
 * Hermano del `PolicyUpdatedConsumer` (mismo molde, misma infra `KafkaConsumerBootstrap`): un groupId propio
 * (`${service}-permission-override`) = UN consumer con su único evento en `handlers()`, aislado del consumer de
 * políticas para que el broadcast del overlay llegue a cada instancia de enforcement. Ambos alimentan el MISMO
 * reader cacheado (el gobierno unificado de ADR-025 §2: un cliente, dos registros).
 */
import { Injectable } from '@nestjs/common';
import { EVENT_SCHEMAS, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap, type KafkaConsumerBootstrapOptions } from '@veo/events/nest';
import { KafkaCachedPolicyReader } from './kafka-cached-policy-reader.js';

const PERMISSION_OVERRIDE_UPDATED = 'permission_override.updated' as const;

@Injectable()
export class PermissionOverrideUpdatedConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly reader: KafkaCachedPolicyReader,
    options: KafkaConsumerBootstrapOptions,
  ) {
    super(options);
  }

  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      [PERMISSION_OVERRIDE_UPDATED]: async (envelope) => {
        // KafkaEventConsumer ya valida el payload contra el registro antes del handler; re-parseamos para
        // obtener el dato TIPADO (defensa en profundidad, mismo patrón que policy-updated.consumer).
        const parsed = EVENT_SCHEMAS[PERMISSION_OVERRIDE_UPDATED].safeParse(envelope.payload);
        if (!parsed.success) {
          this.logger.warn(
            `${PERMISSION_OVERRIDE_UPDATED} con payload inválido (eventId=${envelope.eventId}); ignorado`,
          );
          return;
        }
        this.reader.applyOverrideEvent(parsed.data);
      },
    };
  }

  protected override subscriptionLog(): string {
    return 'Suscrito a permission_override.updated (frescura del overlay de @veo/policy)';
  }
}
