import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer, type EventEnvelope, type EventHandler } from '@veo/events';
import type { Env } from '../config/env.schema';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';

/**
 * Espía sobre el KafkaEventConsumer REAL (start anulado, sin conexión a Kafka): captura el handler
 * que el bootstrap promovido (@veo/events/nest) registra en onModuleInit, para poder invocarlo
 * directamente y verificar parsing + delegación + idempotencia. La validación zod del consumer
 * (`fleetDriverSuspended`) es la real.
 */
const captured: { handler?: EventHandler; byEvent: Record<string, EventHandler> } = { byEvent: {} };

vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  eventType: string,
  handler: EventHandler,
) {
  // El consumer registra DOS handlers (suspended + reactivated). Capturamos por eventType para invocar el
  // que corresponda; `handler` mantiene el ÚLTIMO registrado (compat con los specs de suspensión previos,
  // que invocan `captured.handler` y el envelope lleva el eventType de suspensión).
  captured.byEvent[eventType] = handler;
  captured.handler = captured.byEvent['fleet.driver_suspended'] ?? handler;
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = new ConfigService<Env, true>({ KAFKA_BROKERS: 'localhost:9094' });

function envelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e1',
    eventType: 'fleet.driver.suspended',
    producer: 'fleet-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

const validPayload = {
  driverId: 'd1',
  reason: 'Documento crítico vencido (LICENSE)',
  documentId: 'doc1',
  documentType: 'LICENSE',
  suspendedAt: '2026-06-04T10:00:00.000Z',
};

/** Suspensión por ITV (Lote B): keyeada por userId (User.id), SIN driverId de perfil. */
const itvPayload = {
  userId: 'user-1',
  reason: 'Inspección técnica (ITV) vencida',
  vehicleId: 'veh-1',
  inspectionId: 'insp-1',
  nextDueAt: '2026-05-01T00:00:00.000Z',
  suspendedAt: '2026-06-23T03:00:00.000Z',
};

/** Doble de DriversService con ambas vías de suspensión. */
function makeDrivers() {
  return {
    suspendByFleet: vi.fn(async () => true),
    suspendByFleetForUser: vi.fn(async () => true),
  };
}

describe('DriverSuspensionConsumer · fleet.driver.suspended → Driver.suspendedAt', () => {
  beforeEach(() => {
    captured.handler = undefined;
  });

  it('vía DOCUMENTO (driverId de perfil): suspende directo con suspendByFleet', async () => {
    const drivers = makeDrivers();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(1);
    // Modelo de HOLDS: la vía de documento pasa el `documentType` (causeRef del hold DOCUMENT_EXPIRED).
    expect(drivers.suspendByFleet).toHaveBeenCalledWith(
      'd1',
      new Date('2026-06-04T10:00:00.000Z'),
      'LICENSE',
    );
    // No toca la vía por userId.
    expect(drivers.suspendByFleetForUser).not.toHaveBeenCalled();
  });

  it('vía ITV (userId): resuelve por userId con suspendByFleetForUser — NUNCA pasa el userId a suspendByFleet', async () => {
    const drivers = makeDrivers();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope(itvPayload));
    expect(drivers.suspendByFleetForUser).toHaveBeenCalledTimes(1);
    expect(drivers.suspendByFleetForUser).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-06-23T03:00:00.000Z'),
    );
    // EL FILO: el User.id NUNCA cae en suspendByFleet (que lo trataría como id de perfil → conductor errado).
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('descarta un payload con AMBAS claves (driverId y userId): el refine del schema lo rechaza', async () => {
    const drivers = makeDrivers();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope({ ...validPayload, userId: 'user-1' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
    expect(drivers.suspendByFleetForUser).not.toHaveBeenCalled();
  });

  it('es idempotente extremo-a-extremo: reentrega del mismo evento (suspendByFleet → false) no rompe', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => false) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope(validPayload));
    await captured.handler?.(envelope(validPayload));
    expect(drivers.suspendByFleet).toHaveBeenCalledTimes(2);
    expect(drivers.suspendByFleet).toHaveBeenNthCalledWith(2, 'd1', expect.any(Date), 'LICENSE');
  });

  it('vía DOCUMENTO sin documentType en el payload → causeRef de fallback "UNKNOWN" (honesto, no rompe la idempotencia)', async () => {
    const drivers = makeDrivers();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    const { documentType: _omit, ...noDocType } = validPayload;
    await captured.handler?.(envelope(noDocType));
    expect(drivers.suspendByFleet).toHaveBeenCalledWith('d1', expect.any(Date), 'UNKNOWN');
  });

  it('descarta payloads inválidos sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope({ reason: 'sin driverId' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('descarta suspendedAt no parseable sin tocar la DB', async () => {
    const drivers = { suspendByFleet: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.handler?.(envelope({ ...validPayload, suspendedAt: 'no-es-fecha' }));
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('propaga el error para que Kafka reintente (suspendByFleet es idempotente)', async () => {
    const drivers = {
      suspendByFleet: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(captured.handler?.(envelope(validPayload))).rejects.toThrow('db down');
  });
});

/** Envelope de un evento de REACTIVACIÓN (eventType guion bajo, el que casa con el handler). */
function reactivatedEnvelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e2',
    eventType: 'fleet.driver_reactivated',
    producer: 'fleet-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

/** Doble de DriversService con ambas vías de reactivación. */
function makeReactivators() {
  return {
    reactivateByFleet: vi.fn(async () => true),
    reactivateByFleetForUser: vi.fn(async () => true),
  };
}

const reactivatedByDoc = {
  driverId: 'd1',
  reason: 'Documento crítico regularizado (SOAT)',
  documentId: 'doc1',
  documentType: 'SOAT',
  reactivatedAt: '2026-06-23T11:00:00.000Z',
};

const reactivatedByItv = {
  userId: 'user-1',
  reason: 'Inspección técnica (ITV) regularizada',
  vehicleId: 'veh-1',
  inspectionId: 'insp-2',
  nextDueAt: '2026-09-23T00:00:00.000Z',
  reactivatedAt: '2026-06-23T11:00:00.000Z',
};

describe('DriverSuspensionConsumer · fleet.driver_reactivated → limpia Driver.suspendedAt (solo DOCUMENT_EXPIRED)', () => {
  beforeEach(() => {
    captured.byEvent = {};
  });

  it('vía DOCUMENTO (driverId de perfil): reactiva directo con reactivateByFleet', async () => {
    const drivers = makeReactivators();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(reactivatedByDoc));
    expect(drivers.reactivateByFleet).toHaveBeenCalledTimes(1);
    // Modelo de HOLDS: la vía de documento pasa el `documentType` para quitar SOLO ese hold (no las otras causas).
    expect(drivers.reactivateByFleet).toHaveBeenCalledWith('d1', 'SOAT');
    // EL FILO: nunca pasa el driverId de perfil a la vía por userId.
    expect(drivers.reactivateByFleetForUser).not.toHaveBeenCalled();
  });

  it('vía ITV (userId): resuelve por userId con reactivateByFleetForUser — NUNCA pasa el userId a reactivateByFleet', async () => {
    const drivers = makeReactivators();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(reactivatedByItv));
    expect(drivers.reactivateByFleetForUser).toHaveBeenCalledTimes(1);
    expect(drivers.reactivateByFleetForUser).toHaveBeenCalledWith('user-1');
    // EL FILO: el User.id NUNCA cae en reactivateByFleet (que lo trataría como id de perfil → conductor errado).
    expect(drivers.reactivateByFleet).not.toHaveBeenCalled();
  });

  it('descarta un payload con AMBAS claves (driverId y userId): el refine del schema lo rechaza', async () => {
    const drivers = makeReactivators();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(
      reactivatedEnvelope({ ...reactivatedByDoc, userId: 'user-1' }),
    );
    expect(drivers.reactivateByFleet).not.toHaveBeenCalled();
    expect(drivers.reactivateByFleetForUser).not.toHaveBeenCalled();
  });

  it('es idempotente extremo-a-extremo: reentrega del mismo evento (reactivateByFleet → false) no rompe', async () => {
    const drivers = {
      reactivateByFleet: vi.fn(async () => false),
      reactivateByFleetForUser: vi.fn(async () => false),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(reactivatedByDoc));
    await captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(reactivatedByDoc));
    expect(drivers.reactivateByFleet).toHaveBeenCalledTimes(2);
  });

  it('descarta payloads inválidos (sin claves) sin tocar la DB', async () => {
    const drivers = makeReactivators();
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(
      reactivatedEnvelope({ reason: 'sin sujeto', reactivatedAt: '2026-06-23T11:00:00.000Z' }),
    );
    expect(drivers.reactivateByFleet).not.toHaveBeenCalled();
    expect(drivers.reactivateByFleetForUser).not.toHaveBeenCalled();
  });

  it('propaga el error para que Kafka reintente (reactivateByFleet es idempotente)', async () => {
    const drivers = {
      reactivateByFleet: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(reactivatedByDoc)),
    ).rejects.toThrow('db down');
  });
});

/** Envelope de un `driver.flagged` (lo emite rating-service; topicForEvent → topic 'driver'). */
function flaggedEnvelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e3',
    eventType: 'driver.flagged',
    producer: 'rating-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

describe('DriverSuspensionConsumer · driver.flagged → AUTO-suspensión por rating bajo (hold RATING_LOW)', () => {
  beforeEach(() => {
    captured.byEvent = {};
  });

  it("reason='suspension' → suspende con suspendByRating (driverId de PERFIL, directo)", async () => {
    const drivers = { suspendByRating: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.flagged']?.(
      flaggedEnvelope({ driverId: 'd1', rollingAvg: 3.2, reason: 'suspension' }),
    );
    expect(drivers.suspendByRating).toHaveBeenCalledTimes(1);
    expect(drivers.suspendByRating).toHaveBeenCalledWith('d1', expect.any(String));
  });

  it("reason='review' → NO suspende (es flag de panel): suspendByRating nunca se llama", async () => {
    const drivers = { suspendByRating: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.flagged']?.(
      flaggedEnvelope({ driverId: 'd1', rollingAvg: 4.1, reason: 'review' }),
    );
    expect(drivers.suspendByRating).not.toHaveBeenCalled();
  });

  it('cualquier otra razón desconocida → NO suspende (fail-closed para suspensión)', async () => {
    const drivers = { suspendByRating: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.flagged']?.(
      flaggedEnvelope({ driverId: 'd1', rollingAvg: 4.1, reason: 'reverification' }),
    );
    expect(drivers.suspendByRating).not.toHaveBeenCalled();
  });

  it('payload inválido (sin driverId) → descartado sin tocar la DB', async () => {
    const drivers = { suspendByRating: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.flagged']?.(
      flaggedEnvelope({ rollingAvg: 3.0, reason: 'suspension' }),
    );
    expect(drivers.suspendByRating).not.toHaveBeenCalled();
  });

  it('es idempotente extremo-a-extremo: reentrega del mismo flag (suspendByRating → false) no rompe', async () => {
    const drivers = { suspendByRating: vi.fn(async () => false) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    const env = flaggedEnvelope({ driverId: 'd1', rollingAvg: 3.0, reason: 'suspension' });
    await captured.byEvent['driver.flagged']?.(env);
    await captured.byEvent['driver.flagged']?.(env);
    expect(drivers.suspendByRating).toHaveBeenCalledTimes(2);
  });

  it('propaga el error para que Kafka reintente (suspendByRating es idempotente)', async () => {
    const drivers = {
      suspendByRating: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['driver.flagged']?.(
        flaggedEnvelope({ driverId: 'd1', rollingAvg: 3.0, reason: 'suspension' }),
      ),
    ).rejects.toThrow('db down');
  });
});

/**
 * SEAM catálogo↔operabilidad (ADR 013): fleet apagó/encendió una CLASE de vehículo en el catálogo. El evento llega
 * por la MISMA vía `fleet.driver_suspended`/`fleet.driver_reactivated` pero con el discriminador explícito
 * `holdCause='CATEGORY_DISABLED'`, keyeado por `userId` (= Vehicle.driverId). El consumer debe rutearlo a la vía de
 * catálogo (suspendByFleetCategory/reactivateByFleetCategory), NO a la de ITV (que también va por userId).
 */
const categorySuspended = {
  userId: 'user-1',
  reason: 'Categoría de servicio desactivada por el operador (catálogo)',
  holdCause: 'CATEGORY_DISABLED',
  suspendedAt: '2026-07-09T10:00:00.000Z',
};

const categoryReactivated = {
  userId: 'user-1',
  reason: 'Categoría de servicio re-activada por el operador (catálogo)',
  holdCause: 'CATEGORY_DISABLED',
  reactivatedAt: '2026-07-09T12:00:00.000Z',
};

describe('DriverSuspensionConsumer · holdCause=CATEGORY_DISABLED → vía de catálogo (NO ITV)', () => {
  beforeEach(() => {
    captured.byEvent = {};
    captured.handler = undefined;
  });

  it('suspende con suspendByFleetCategory(userId, at) — NUNCA con la vía de ITV/documento', async () => {
    const drivers = {
      suspendByFleetCategory: vi.fn(async () => true),
      suspendByFleetForUser: vi.fn(async () => true),
      suspendByFleet: vi.fn(async () => true),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_suspended']?.(envelope(categorySuspended));
    expect(drivers.suspendByFleetCategory).toHaveBeenCalledTimes(1);
    expect(drivers.suspendByFleetCategory).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-07-09T10:00:00.000Z'),
    );
    // EL FILO: userId con holdCause=CATEGORY_DISABLED NUNCA cae en la vía de ITV (INSPECTION_EXPIRED) ni documento.
    expect(drivers.suspendByFleetForUser).not.toHaveBeenCalled();
    expect(drivers.suspendByFleet).not.toHaveBeenCalled();
  });

  it('reincorpora con reactivateByFleetCategory(userId) — NUNCA con la vía de ITV/documento', async () => {
    const drivers = {
      reactivateByFleetCategory: vi.fn(async () => true),
      reactivateByFleetForUser: vi.fn(async () => true),
      reactivateByFleet: vi.fn(async () => true),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_reactivated']?.(reactivatedEnvelope(categoryReactivated));
    expect(drivers.reactivateByFleetCategory).toHaveBeenCalledTimes(1);
    expect(drivers.reactivateByFleetCategory).toHaveBeenCalledWith('user-1');
    expect(drivers.reactivateByFleetForUser).not.toHaveBeenCalled();
    expect(drivers.reactivateByFleet).not.toHaveBeenCalled();
  });

  it('es idempotente: reentrega de la suspensión de catálogo (→ false) no rompe', async () => {
    const drivers = { suspendByFleetCategory: vi.fn(async () => false) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['fleet.driver_suspended']?.(envelope(categorySuspended));
    await captured.byEvent['fleet.driver_suspended']?.(envelope(categorySuspended));
    expect(drivers.suspendByFleetCategory).toHaveBeenCalledTimes(2);
  });

  it('propaga el error para que Kafka reintente (suspendByFleetCategory es idempotente)', async () => {
    const drivers = {
      suspendByFleetCategory: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['fleet.driver_suspended']?.(envelope(categorySuspended)),
    ).rejects.toThrow('db down');
  });
});

function excessiveCancellationsEnvelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e4',
    eventType: 'driver.excessive_cancellations',
    producer: 'dispatch-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

const validCancellations = {
  driverId: 'd1',
  count: 5,
  windowStart: '2026-06-22T00:00:00.000Z',
  occurredAt: '2026-06-23T00:00:00.000Z',
};

describe('DriverSuspensionConsumer · driver.excessive_cancellations → AUTO-suspensión TEMPORAL', () => {
  it('delega en suspendByCancellations con el driverId de PERFIL y el count', async () => {
    const drivers = { suspendByCancellations: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.excessive_cancellations']?.(
      excessiveCancellationsEnvelope(validCancellations),
    );
    expect(drivers.suspendByCancellations).toHaveBeenCalledTimes(1);
    // driverId de PERFIL (= Trip.driverId) como primer argumento; el segundo es el reason legible.
    expect(drivers.suspendByCancellations).toHaveBeenCalledWith('d1', expect.any(String));
  });

  it('descarta un payload inválido (sin driverId) sin llamar al servicio', async () => {
    const drivers = { suspendByCancellations: vi.fn(async () => true) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.excessive_cancellations']?.(
      excessiveCancellationsEnvelope({ count: 5, windowStart: 'x', occurredAt: 'y' }),
    );
    expect(drivers.suspendByCancellations).not.toHaveBeenCalled();
  });

  it('propaga el error para que Kafka reintente (suspendByCancellations es idempotente)', async () => {
    const drivers = {
      suspendByCancellations: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['driver.excessive_cancellations']?.(
        excessiveCancellationsEnvelope(validCancellations),
      ),
    ).rejects.toThrow('db down');
  });
});

/**
 * Envelope de un `driver.suspended` (lo emite el PROPIO identity por outbox al suspender disciplinariamente;
 * topicForEvent → topic 'driver', el mismo del consumer). Es el BACKSTOP durable del revoke de sesión.
 */
function selfSuspendedEnvelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'e5',
    eventType: 'driver.suspended',
    producer: 'identity-service',
    occurredAt: new Date().toISOString(),
    payload,
  } as EventEnvelope<unknown>;
}

const selfSuspended = {
  driverId: 'd1',
  reason: 'Suspensión disciplinaria del operador',
  suspendedAt: '2026-06-30T12:00:00.000Z',
  userId: 'user-1',
};

describe('DriverSuspensionConsumer · driver.suspended → BACKSTOP durable del reseal de revocación', () => {
  beforeEach(() => {
    captured.byEvent = {};
  });

  it('resella por userId del PAYLOAD, con el suspendedAt del EVENTO (Date), NO con driverId ni now()', async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'reconciled' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(selfSuspended));
    expect(drivers.resealSuspensionRevocation).toHaveBeenCalledTimes(1);
    expect(drivers.resealSuspensionRevocation).toHaveBeenCalledWith(
      'd1',
      'user-1',
      new Date('2026-06-30T12:00:00.000Z'),
    );
  });

  it('evento SIN userId (en vuelo pre-deploy) → pasa undefined; el servicio resuelve driverId→userId', async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'reconciled' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    const { userId: _omit, ...noUserId } = selfSuspended;
    await captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(noUserId));
    expect(drivers.resealSuspensionRevocation).toHaveBeenCalledWith(
      'd1',
      undefined,
      expect.any(Date),
    );
  });

  it('IDEMPOTENTE: reentrega del mismo evento (outcome duplicate) no rompe ni duplica efecto', async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'duplicate' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(selfSuspended));
    await captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(selfSuspended));
    expect(drivers.resealSuspensionRevocation).toHaveBeenCalledTimes(2);
    expect(drivers.resealSuspensionRevocation).toHaveBeenNthCalledWith(
      2,
      'd1',
      'user-1',
      expect.any(Date),
    );
  });

  it("outcome 'skipped' (sin userId resoluble): no rompe (no-op observable)", async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'skipped' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(selfSuspended)),
    ).resolves.toBeUndefined();
    expect(drivers.resealSuspensionRevocation).toHaveBeenCalledTimes(1);
  });

  it('descarta payload inválido (sin driverId) sin resellar', async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'reconciled' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.suspended']?.(
      selfSuspendedEnvelope({ reason: 'x', suspendedAt: selfSuspended.suspendedAt }),
    );
    expect(drivers.resealSuspensionRevocation).not.toHaveBeenCalled();
  });

  it('descarta suspendedAt no parseable sin resellar', async () => {
    const drivers = { resealSuspensionRevocation: vi.fn(async () => 'reconciled' as const) };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await captured.byEvent['driver.suspended']?.(
      selfSuspendedEnvelope({ ...selfSuspended, suspendedAt: 'no-es-fecha' }),
    );
    expect(drivers.resealSuspensionRevocation).not.toHaveBeenCalled();
  });

  it('propaga el error de Redis para que Kafka reintente (el reseal es idempotente/monotónico)', async () => {
    const drivers = {
      resealSuspensionRevocation: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    await new DriverSuspensionConsumer(drivers as never, config).onModuleInit();
    await expect(
      captured.byEvent['driver.suspended']?.(selfSuspendedEnvelope(selfSuspended)),
    ).rejects.toThrow('redis down');
  });
});
