/**
 * COBERTURA "TODO TODO" (regla de oro ejecutable · VEO_SPEC_ADMIN:106 · FOUNDATION §0.4/§6 · Ley 29733).
 *
 * Recorre TODO el catálogo `EVENT_SCHEMAS` de @veo/events y exige que CADA evento mutante esté auditado
 * (tiene handler en `AuditConsumer.handlers()`) O esté en la lista EXPLÍCITA de exclusiones con su razón.
 * Un evento NUEVO en EVENT_SCHEMAS sin handler ni exclusión ROMPE este test → anti-drift: nadie agrega un
 * evento de dominio sin decidir conscientemente si se audita. Espeja el bloque AUDIT_EXCLUSIONS del consumer.
 *
 * Captura los handlers como el resto de la suite del consumer: espía `KafkaEventConsumer.on` (con `start`
 * anulado) para no tocar Kafka real, y mira las KEYS registradas (la suscripción se auto-deriva de ellas).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EVENT_SCHEMAS, KafkaEventConsumer, type EventEnvelope, type EventType } from '@veo/events';
import { AuditConsumer } from './audit.consumer';
import { type AuditService } from '../audit/audit.service';
import { validateEnv, type Env } from '../config/env.schema';

type Handler = (envelope: EventEnvelope<unknown>) => Promise<void>;

function makeConfig(): ConfigService<Env, true> {
  const env = validateEnv({ DATABASE_URL: 'postgresql://veo:veo@localhost:5433/veo' });
  return new ConfigService<Env, true>(env);
}

/**
 * EXCLUSIONES DOCUMENTADAS — eventos de EVENT_SCHEMAS que NO se auditan, con su razón. DEBE espejar el bloque
 * AUDIT_EXCLUSIONS del consumer. Mover un evento de acá a un handler (o viceversa) es una decisión consciente.
 *
 * Con la PROYECCIÓN ALLOWLIST (projectAuditPayload) la PII YA NO es razón de exclusión: geo/body/to se descartan
 * antes del WORM, así que esos eventos SÍ se auditan. Quedan SOLO dos clases: FIREHOSE (volumen explota la
 * hash-chain) y eventos-que-no-son-una-mutación-auditable (loop del propio servicio / pre-aviso).
 */
const AUDIT_EXCLUSIONS: Readonly<Partial<Record<EventType, string>>> = {
  // Firehose (el volumen explota la hash-chain inmutable + la vuelve un tracker; valor forense nulo).
  'driver.location_updated': 'firehose GPS (1 ping/~15s por conductor online)',
  'driver.entered_zone': 'geofence de alta frecuencia (tracking de dispatch, no una mutación de negocio)',
  // No es una mutación de negocio auditable.
  'audit.recorded': 'lo emite este propio servicio (auditar su auditoría sería un bucle)',
  'fleet.document_expiring': 'pre-aviso de vencimiento (no un cambio de estado; el vencimiento es document_expired)',
};

describe('AuditConsumer · cobertura "todo todo" (anti-drift, regla de oro)', () => {
  const handlers = new Map<string, Handler>();

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
    await new AuditConsumer(
      { recordFromEvent: vi.fn(async () => ({ created: true })) } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('TODO evento de EVENT_SCHEMAS está auditado O excluido explícitamente (sin huérfanos)', () => {
    const orphans: string[] = [];
    for (const eventType of Object.keys(EVENT_SCHEMAS) as EventType[]) {
      const audited = handlers.has(eventType);
      const excluded = eventType in AUDIT_EXCLUSIONS;
      // XOR: un evento auditado NO debe estar también excluido (señal de inconsistencia con el consumer).
      expect(audited && excluded, `${eventType} está auditado Y excluido a la vez`).toBe(false);
      if (!audited && !excluded) orphans.push(eventType);
    }
    expect(
      orphans,
      `eventos sin handler ni exclusión (agregá handler en handlers() o entrada en AUDIT_EXCLUSIONS): ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('ningún handler registrado está fuera de EVENT_SCHEMAS (no hay handler fantasma)', () => {
    const known = new Set(Object.keys(EVENT_SCHEMAS));
    for (const registered of handlers.keys()) {
      expect(known.has(registered), `handler para evento inexistente: ${registered}`).toBe(true);
    }
  });

  it('cada exclusión corresponde a un evento real de EVENT_SCHEMAS (no hay exclusión obsoleta)', () => {
    for (const eventType of Object.keys(AUDIT_EXCLUSIONS)) {
      expect(eventType in EVENT_SCHEMAS, `exclusión de evento inexistente: ${eventType}`).toBe(true);
    }
  });

  it('la única exclusión por FIREHOSE incluye driver.location_updated (exclusión canónica)', () => {
    expect('driver.location_updated' in AUDIT_EXCLUSIONS).toBe(true);
    expect(handlers.has('driver.location_updated')).toBe(false);
  });
});
