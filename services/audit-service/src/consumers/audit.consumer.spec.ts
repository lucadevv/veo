/**
 * Unit del AuditConsumer — verifica el wiring de handlers SIN Kafka real.
 * Espía `KafkaEventConsumer.prototype.on` para capturar los handlers que el consumer registra en su
 * constructor, luego dispara un envelope por el handler y comprueba que delega en
 * `AuditService.recordFromEvent` con el mapeo correcto. Foco: derecho al olvido (BR-S06).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  createEnvelope,
  KafkaEventConsumer,
  topicForEvent,
  type EventEnvelope,
} from '@veo/events';
import { AuditConsumer } from './audit.consumer';
import { type AuditService, type EventAuditMapping } from '../audit/audit.service';
import { validateEnv, type Env } from '../config/env.schema';

type Handler = (envelope: EventEnvelope<unknown>) => Promise<void>;

/** ConfigService real con el entorno mínimo validado (sin tocar Kafka/DB en construcción). */
function makeConfig(): ConfigService<Env, true> {
  const env = validateEnv({ DATABASE_URL: 'postgresql://veo:veo@localhost:5433/veo' });
  return new ConfigService<Env, true>(env);
}

describe('AuditConsumer · derecho al olvido (BR-S06)', () => {
  const handlers = new Map<string, Handler>();
  let recordFromEvent: ReturnType<typeof vi.fn>;
  let audit: AuditService;

  beforeEach(() => {
    handlers.clear();
    // Captura cada handler registrado en el constructor del consumer; evita Kafka real.
    vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
      this: KafkaEventConsumer,
      type: string,
      handler: Handler,
    ) {
      handlers.set(type, handler);
      return this;
    } as KafkaEventConsumer['on']);

    recordFromEvent = vi.fn(async () => ({ created: true }));
    audit = { recordFromEvent } as unknown as AuditService;
    // Construir el consumer registra los handlers (vía el spy).
    new AuditConsumer(audit, makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra un handler para user.deleted (borrado efectivo / sweep)', () => {
    expect(handlers.has('user.deleted')).toBe(true);
  });

  it('registra un handler para user.deletion_requested (solicitud de borrado)', () => {
    expect(handlers.has('user.deletion_requested')).toBe(true);
  });

  it('audita user.deleted con resourceType=user y actor/recurso = userId', async () => {
    const envelope = createEnvelope({
      eventType: 'user.deleted',
      producer: 'identity-service',
      payload: { userId: 'u-123', driverId: 'd-9', at: new Date().toISOString() },
    });

    await handlers.get('user.deleted')!(envelope as EventEnvelope<unknown>);

    expect(recordFromEvent).toHaveBeenCalledTimes(1);
    const [recvEnvelope, topic, mapping] = recordFromEvent.mock.calls[0] as [
      EventEnvelope<unknown>,
      string,
      EventAuditMapping,
    ];
    expect(recvEnvelope.eventId).toBe(envelope.eventId);
    expect(topic).toBe(topicForEvent('user.deleted'));
    expect(mapping).toEqual({ actorId: 'u-123', resourceType: 'user', resourceId: 'u-123' });
  });

  it('audita user.deletion_requested mapeando al userId', async () => {
    const envelope = createEnvelope({
      eventType: 'user.deletion_requested',
      producer: 'identity-service',
      payload: {
        userId: 'u-777',
        requestedAt: new Date().toISOString(),
        graceUntil: new Date().toISOString(),
      },
    });

    await handlers.get('user.deletion_requested')!(envelope as EventEnvelope<unknown>);

    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'u-777', resourceType: 'user', resourceId: 'u-777' });
  });
});
