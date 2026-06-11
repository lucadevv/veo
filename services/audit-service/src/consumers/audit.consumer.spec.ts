/**
 * Unit del AuditConsumer — verifica el wiring de handlers SIN Kafka real.
 * Espía `KafkaEventConsumer.prototype.on` (con `start` anulado) para capturar los handlers que el
 * bootstrap promovido (@veo/events/nest) registra en onModuleInit, luego dispara un envelope por el
 * handler y comprueba que delega en `AuditService.recordFromEvent` con el mapeo correcto.
 * Foco: derecho al olvido (BR-S06).
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

  beforeEach(async () => {
    handlers.clear();
    // Captura cada handler que el bootstrap registra en onModuleInit; evita Kafka real.
    vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
      this: KafkaEventConsumer,
      type: string,
      handler: Handler,
    ) {
      handlers.set(type, handler);
      return this;
    });
    vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);

    recordFromEvent = vi.fn(async () => ({ created: true }));
    audit = { recordFromEvent } as unknown as AuditService;
    // onModuleInit registra los handlers (vía el spy) y "arranca" el consumer anulado.
    await new AuditConsumer(audit, makeConfig()).onModuleInit();
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

    await handlers.get('user.deleted')!(envelope);

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

    await handlers.get('user.deletion_requested')!(envelope);

    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'u-777', resourceType: 'user', resourceId: 'u-777' });
  });
});

describe('AuditConsumer · ciclo de vida del viaje (trazabilidad forense Ley 29733)', () => {
  const handlers = new Map<string, Handler>();
  let recordFromEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handlers.clear();
    vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
      this: KafkaEventConsumer,
      type: string,
      handler: Handler,
    ) {
      handlers.set(type, handler);
      return this;
    });
    vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
    recordFromEvent = vi.fn(async () => ({ created: true }));
    await new AuditConsumer({ recordFromEvent } as unknown as AuditService, makeConfig()).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra TODAS las transiciones del ciclo de vida', () => {
    for (const t of [
      'trip.assigned', 'trip.accepted', 'trip.arriving', 'trip.arrived', 'trip.started',
      'trip.completed', 'trip.cancelled', 'trip.expired', 'trip.failed', 'trip.child_code_failed',
    ]) {
      expect(handlers.has(t), `falta handler ${t}`).toBe(true);
    }
  });

  it('NO audita trip.requested/bid_posted/reassigning (llevan geo → no van al WORM inmutable)', () => {
    expect(handlers.has('trip.requested')).toBe(false);
    expect(handlers.has('trip.bid_posted')).toBe(false);
    expect(handlers.has('trip.reassigning')).toBe(false);
  });

  it('trip.started → actorId=driverId, resourceType=trip, resourceId=tripId', async () => {
    const envelope = createEnvelope({
      eventType: 'trip.started',
      producer: 'trip-service',
      payload: { tripId: 't-1', driverId: 'drv-9', startedAt: new Date().toISOString() },
    });
    await handlers.get('trip.started')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'drv-9', resourceType: 'trip', resourceId: 't-1' });
  });

  it('trip.cancelled mapea el actorId según `by` (DRIVER→driverId, PASSENGER→passengerId, SYSTEM→system)', async () => {
    const mk = (by: 'DRIVER' | 'PASSENGER' | 'SYSTEM', extra: Record<string, unknown>) =>
      createEnvelope({
        eventType: 'trip.cancelled',
        producer: 'trip-service',
        payload: { tripId: 't-1', by, penaltyCents: 0, ...extra },
      });
    await handlers.get('trip.cancelled')!(mk('DRIVER', { driverId: 'drv-1' }));
    await handlers.get('trip.cancelled')!(mk('PASSENGER', { passengerId: 'pax-1' }));
    await handlers.get('trip.cancelled')!(mk('SYSTEM', {}));
    const actors = recordFromEvent.mock.calls.map((c) => (c[2] as EventAuditMapping).actorId);
    expect(actors).toEqual(['drv-1', 'pax-1', 'system']);
  });

  it('trip.expired → actorId=system (cierre del watchdog)', async () => {
    const envelope = createEnvelope({
      eventType: 'trip.expired',
      producer: 'trip-service',
      payload: { tripId: 't-1', passengerId: 'pax-1', fromStatus: 'REQUESTED', staleMinutes: 12, at: new Date().toISOString() },
    });
    await handlers.get('trip.expired')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping.actorId).toBe('system');
  });
});
