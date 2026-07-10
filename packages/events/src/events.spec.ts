import { describe, it, expect } from 'vitest';
import { createEnvelope, envelopeSchema } from './envelope.js';
import {
  EVENT_SCHEMAS,
  topicForEvent,
  schemaForEvent,
  FLAG_REASON,
  type EventPayload,
} from './schemas.js';
import { isPermanentDataError, isUuid } from './poison.js';

describe('envelope', () => {
  it('crea un envelope válido con eventId UUIDv7 y defaults', () => {
    const payload: EventPayload<'trip.requested'> = {
      tripId: 't1',
      passengerId: 'p1',
      origin: { lat: -12.1, lon: -77.0 },
      destination: { lat: -12.09, lon: -77.03 },
      fareCents: 1500,
      childMode: false,
    };
    const env = createEnvelope({ eventType: 'trip.requested', producer: 'trip-service', payload });
    expect(envelopeSchema.safeParse(env).success).toBe(true);
    expect(env.schemaVersion).toBe(1);
    expect(EVENT_SCHEMAS['trip.requested'].safeParse(env.payload).success).toBe(true);
  });
});

describe('topic routing', () => {
  it('mapea eventType → topic por dominio', () => {
    expect(topicForEvent('trip.completed')).toBe('trip');
    expect(topicForEvent('panic.triggered')).toBe('panic');
    expect(topicForEvent('payment.captured')).toBe('payment');
  });
  it('user.kyc_verified enruta al topic user', () => {
    expect(topicForEvent('user.kyc_verified')).toBe('user');
  });
  it('permission_override.updated (overlay ADR-025) tiene su PROPIO topic, aislado de policy', () => {
    expect(topicForEvent('permission_override.updated')).toBe('permission_override');
    expect(topicForEvent('policy.updated')).toBe('policy');
  });

  describe('aislamiento del firehose de GPS (FIX rating-firehose)', () => {
    it('driver.location_updated (firehose) va a su PROPIO topic driver-location, NO al topic driver', () => {
      expect(topicForEvent('driver.location_updated')).toBe('driver-location');
      expect(topicForEvent('driver.location_updated')).not.toBe('driver');
    });

    it('los eventos de CICLO DE VIDA driver.* siguen en el topic driver (baja frecuencia)', () => {
      // Estos los oyen rating (driver.reactivated) y admin-bff; deben compartir el topic 'driver' SIN el firehose.
      expect(topicForEvent('driver.reactivated')).toBe('driver');
      expect(topicForEvent('driver.suspended')).toBe('driver');
      expect(topicForEvent('driver.flagged')).toBe('driver');
      expect(topicForEvent('driver.verified')).toBe('driver');
      // Auto-suspensión por exceso de cancelaciones: ciclo de vida, comparte el topic 'driver' (no el firehose).
      expect(topicForEvent('driver.excessive_cancellations')).toBe('driver');
    });
  });

  describe('permission_override.updated · schema tipado (overlay ADR-025)', () => {
    it('ACEPTA el payload de un par restado y RECHAZA uno sin role/permission o con hidden no-booleano', () => {
      const schema = schemaForEvent('permission_override.updated');
      expect(schema).toBeDefined();
      const ok = schema!.safeParse({
        role: 'DISPATCHER',
        permission: 'drivers:approve',
        hidden: true,
        version: 3,
        updatedBy: 'sup1',
        updatedAt: '2026-07-10T00:00:00.000Z',
      });
      expect(ok.success).toBe(true);
      // Falta permission.
      expect(
        schema!.safeParse({ role: 'DISPATCHER', hidden: true, version: 1, updatedBy: 'x', updatedAt: 'y' })
          .success,
      ).toBe(false);
      // hidden no-booleano.
      expect(
        schema!.safeParse({
          role: 'DISPATCHER',
          permission: 'ops:view',
          hidden: 'yes',
          version: 1,
          updatedBy: 'x',
          updatedAt: 'y',
        }).success,
      ).toBe(false);
      // version no-positiva.
      expect(
        schema!.safeParse({
          role: 'DISPATCHER',
          permission: 'ops:view',
          hidden: true,
          version: 0,
          updatedBy: 'x',
          updatedAt: 'y',
        }).success,
      ).toBe(false);
    });
  });

  describe('driver.excessive_cancellations · schema tipado', () => {
    it('ACEPTA un payload válido y RECHAZA uno sin driverId', () => {
      const schema = schemaForEvent('driver.excessive_cancellations');
      expect(schema).toBeDefined();
      const ok = schema!.safeParse({
        driverId: 'd1',
        count: 5,
        windowStart: '2026-06-22T00:00:00.000Z',
        occurredAt: '2026-06-23T00:00:00.000Z',
      });
      expect(ok.success).toBe(true);
      const bad = schema!.safeParse({ count: 5, windowStart: 'x', occurredAt: 'y' });
      expect(bad.success).toBe(false);
    });
  });

  describe('audit.recorded · contrato productor↔schema (guard del POISON)', () => {
    it('ACEPTA el payload que audit-service emite (entryId + at + tamper-evident)', () => {
      const schema = schemaForEvent('audit.recorded');
      expect(schema).toBeDefined();
      // Forma EXACTA que emite audit.repository.ts tras el fix.
      const ok = schema!.safeParse({
        entryId: 'a1',
        seq: '42',
        eventId: 'e1',
        actorId: 'u1',
        action: 'biometric.enrolled',
        resourceType: 'driver',
        resourceId: 'd1',
        at: '2026-06-25T12:37:38.329Z',
        hash: 'deadbeef',
      });
      expect(ok.success).toBe(true);
    });

    it('RECHAZA la forma vieja rota (auditId en vez de entryId, sin at) — el bug del POISON', () => {
      const schema = schemaForEvent('audit.recorded');
      const bad = schema!.safeParse({
        auditId: 'a1',
        seq: '42',
        eventId: 'e1',
        action: 'x',
        resourceType: 'driver',
        resourceId: 'd1',
        hash: 'deadbeef',
      });
      expect(bad.success).toBe(false);
    });
  });
});

describe('registro de schemas', () => {
  it('valida payload de panic (BR-S04 con dedupKey)', () => {
    const schema = schemaForEvent('panic.triggered');
    expect(schema).toBeDefined();
    const ok = schema!.safeParse({
      panicId: 'pn1',
      tripId: 't1',
      passengerId: 'p1',
      geo: { lat: -12.1, lon: -77.0 },
      dedupKey: 'd1',
      triggeredAt: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
  });
  it('rechaza payload inválido', () => {
    expect(EVENT_SCHEMAS['rating.created'].safeParse({ stars: 9 }).success).toBe(false);
  });

  describe('driver.flagged / passenger.flagged · reason es enum tipado (FLAG_REASON, no z.string crudo)', () => {
    it('driver.flagged ACEPTA un reason del enum (suspension/review) y RECHAZA uno desconocido', () => {
      const base = { driverId: 'd1', rollingAvg: 3.9 };
      expect(
        EVENT_SCHEMAS['driver.flagged'].safeParse({ ...base, reason: FLAG_REASON.SUSPENSION })
          .success,
      ).toBe(true);
      expect(
        EVENT_SCHEMAS['driver.flagged'].safeParse({ ...base, reason: FLAG_REASON.REVIEW }).success,
      ).toBe(true);
      // reason fuera de FLAG_REASON → falla-cerrado (no se acopla por string crudo).
      expect(EVENT_SCHEMAS['driver.flagged'].safeParse({ ...base, reason: 'banned' }).success).toBe(
        false,
      );
      expect(EVENT_SCHEMAS['driver.flagged'].safeParse({ ...base, reason: '' }).success).toBe(
        false,
      );
    });

    it('passenger.flagged ACEPTA reverification y RECHAZA un reason desconocido', () => {
      const base = { passengerId: 'p1', rollingAvg: 3.5 };
      expect(
        EVENT_SCHEMAS['passenger.flagged'].safeParse({
          ...base,
          reason: FLAG_REASON.REVERIFICATION,
        }).success,
      ).toBe(true);
      expect(
        EVENT_SCHEMAS['passenger.flagged'].safeParse({ ...base, reason: 'nope' }).success,
      ).toBe(false);
    });
  });

  describe('panic.fanout_requested · contrato anti-PII (FOUNDATION §0.7)', () => {
    const validPayload = {
      panicId: 'pn1',
      tripId: 't1',
      passengerId: 'p1',
      geo: { lat: -12.1, lon: -77.0 },
      contactIds: ['c1', 'c2'],
      shareLink: 'https://veo.pe/s/abc123',
    };

    it('valida un payload con SOLO IDs + deep-link', () => {
      const schema = schemaForEvent('panic.fanout_requested');
      expect(schema).toBeDefined();
      expect(schema!.safeParse(validPayload).success).toBe(true);
    });

    it('enruta al topic panic', () => {
      expect(topicForEvent('panic.fanout_requested')).toBe('panic');
    });

    it('RECHAZA un teléfono filtrado en el payload (PII, .strict falla-cerrado)', () => {
      const leaked = { ...validPayload, phone: '+51987654321' };
      expect(EVENT_SCHEMAS['panic.fanout_requested'].safeParse(leaked).success).toBe(false);
    });

    it('RECHAZA un nombre de contacto filtrado en el payload (PII)', () => {
      const leaked = { ...validPayload, contactName: 'Maria Perez' };
      expect(EVENT_SCHEMAS['panic.fanout_requested'].safeParse(leaked).success).toBe(false);
    });

    it('el payload válido NO contiene ningún campo de PII (teléfono/nombre/email)', () => {
      const keys = Object.keys(validPayload);
      for (const piiKey of ['phone', 'name', 'contactName', 'email', 'phones', 'contacts']) {
        expect(keys).not.toContain(piiKey);
      }
    });
  });

  describe('panic.acknowledged / panic.resolved · contrato ENRIQUECIDO (dominó del cierre de pánico)', () => {
    it('panic.acknowledged valida con tripId + passengerId enriquecidos', () => {
      const ok = {
        panicId: 'pn1',
        tripId: 't1',
        passengerId: 'p1',
        operatorId: 'op1',
        ackAt: new Date().toISOString(),
      };
      expect(EVENT_SCHEMAS['panic.acknowledged'].safeParse(ok).success).toBe(true);
      // Sin el enriquecido (tripId/passengerId) ⇒ RECHAZA: notification no podría pushear al pasajero.
      const { tripId: _t, ...sinTrip } = ok;
      expect(EVENT_SCHEMAS['panic.acknowledged'].safeParse(sinTrip).success).toBe(false);
      const { passengerId: _p, ...sinPax } = ok;
      expect(EVENT_SCHEMAS['panic.acknowledged'].safeParse(sinPax).success).toBe(false);
    });

    it('panic.resolved valida con tripId + passengerId + status del ENUM (RESOLVED | FALSE_ALARM)', () => {
      const base = {
        panicId: 'pn1',
        tripId: 't1',
        passengerId: 'p1',
        resolvedBy: 'op1',
        at: new Date().toISOString(),
      };
      expect(
        EVENT_SCHEMAS['panic.resolved'].safeParse({ ...base, status: 'RESOLVED' }).success,
      ).toBe(true);
      expect(
        EVENT_SCHEMAS['panic.resolved'].safeParse({ ...base, status: 'FALSE_ALARM' }).success,
      ).toBe(true);
    });

    it('panic.resolved RECHAZA un status FUERA del enum (cero strings mágicos, falla-cerrado)', () => {
      const base = {
        panicId: 'pn1',
        tripId: 't1',
        passengerId: 'p1',
        resolvedBy: 'op1',
        at: new Date().toISOString(),
      };
      // Estados que NO son de cierre, o basura: el contrato los rechaza (no desenmascararían bien aguas abajo).
      for (const bad of ['TRIGGERED', 'ACKNOWLEDGED', 'resolved', 'CLOSED', '']) {
        expect(
          EVENT_SCHEMAS['panic.resolved'].safeParse({ ...base, status: bad }).success,
          `status ${bad}`,
        ).toBe(false);
      }
    });

    it('panic.resolved sin tripId/passengerId enriquecido ⇒ RECHAZA', () => {
      const base = {
        panicId: 'pn1',
        status: 'FALSE_ALARM',
        resolvedBy: 'op1',
        at: new Date().toISOString(),
      };
      expect(EVENT_SCHEMAS['panic.resolved'].safeParse(base).success).toBe(false);
    });
  });

  it('valida payload de user.kyc_verified (KYC del pasajero)', () => {
    const schema = schemaForEvent('user.kyc_verified');
    expect(schema).toBeDefined();
    const ok = schema!.safeParse({
      userId: 'u1',
      kycStatus: 'VERIFIED',
      verifiedAt: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
    expect(EVENT_SCHEMAS['user.kyc_verified'].safeParse({ userId: 'u1' }).success).toBe(false);
  });
});

describe('PUJA / negociación (ADR 010 §4)', () => {
  it('trip.bid_posted: acepta válido, rechaza bid negativo', () => {
    const ok: EventPayload<'trip.bid_posted'> = {
      tripId: 't1',
      passengerId: 'p1',
      bidCents: 700,
      vehicleType: 'CAR',
      origin: { lat: -12.1, lon: -77.0 },
      windowSec: 60,
      negotiationSeq: 1,
    };
    expect(EVENT_SCHEMAS['trip.bid_posted'].safeParse(ok).success).toBe(true);
    // bidCents debe ser entero positivo
    expect(EVENT_SCHEMAS['trip.bid_posted'].safeParse({ ...ok, bidCents: -700 }).success).toBe(
      false,
    );
    // H13 — negotiationSeq debe ser entero positivo
    expect(EVENT_SCHEMAS['trip.bid_posted'].safeParse({ ...ok, negotiationSeq: 0 }).success).toBe(
      false,
    );
    // windowSec faltante
    const { windowSec: _w, ...sinWindow } = ok;
    expect(EVENT_SCHEMAS['trip.bid_posted'].safeParse(sinWindow).success).toBe(false);
  });

  it('dispatch.offer_made: ACCEPT_PRICE y COUNTER válidos, rechaza kind inválido', () => {
    const accept: EventPayload<'dispatch.offer_made'> = {
      tripId: 't1',
      driverId: 'd1',
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
      etaSeconds: 0,
    };
    const counter: EventPayload<'dispatch.offer_made'> = {
      ...accept,
      kind: 'COUNTER',
      priceCents: 900,
    };
    expect(EVENT_SCHEMAS['dispatch.offer_made'].safeParse(accept).success).toBe(true);
    expect(EVENT_SCHEMAS['dispatch.offer_made'].safeParse(counter).success).toBe(true);
    // kind fuera del enum (offer_countered consolidado en este evento, no es un kind)
    expect(
      EVENT_SCHEMAS['dispatch.offer_made'].safeParse({ ...accept, kind: 'COUNTERED' }).success,
    ).toBe(false);
    // etaSeconds no puede ser negativo
    expect(
      EVENT_SCHEMAS['dispatch.offer_made'].safeParse({ ...accept, etaSeconds: -1 }).success,
    ).toBe(false);
  });

  it('dispatch.offer_accepted: acepta válido, rechaza priceCents negativo', () => {
    const ok: EventPayload<'dispatch.offer_accepted'> = {
      tripId: 't1',
      driverId: 'd1',
      priceCents: 700,
      negotiationSeq: 1,
    };
    expect(EVENT_SCHEMAS['dispatch.offer_accepted'].safeParse(ok).success).toBe(true);
    expect(
      EVENT_SCHEMAS['dispatch.offer_accepted'].safeParse({ ...ok, priceCents: -1 }).success,
    ).toBe(false);
    // driverId faltante
    expect(
      EVENT_SCHEMAS['dispatch.offer_accepted'].safeParse({ tripId: 't1', priceCents: 700 }).success,
    ).toBe(false);
    // H13 — negotiationSeq faltante / no positivo
    expect(
      EVENT_SCHEMAS['dispatch.offer_accepted'].safeParse({ ...ok, negotiationSeq: 0 }).success,
    ).toBe(false);
  });

  it('dispatch.no_offers: acepta reasons válidos, rechaza reason fuera del enum', () => {
    const ok: EventPayload<'dispatch.no_offers'> = { tripId: 't1', reason: 'window_expired' };
    expect(EVENT_SCHEMAS['dispatch.no_offers'].safeParse(ok).success).toBe(true);
    expect(
      EVENT_SCHEMAS['dispatch.no_offers'].safeParse({ ...ok, reason: 'all_lapsed' }).success,
    ).toBe(true);
    expect(EVENT_SCHEMAS['dispatch.no_offers'].safeParse({ ...ok, reason: 'nope' }).success).toBe(
      false,
    );
  });

  it('trip.reassigning: acepta válido (enriquecido), rechaza reason inválido, bid negativo y campos faltantes', () => {
    const ok: EventPayload<'trip.reassigning'> = {
      tripId: 't1',
      driverId: 'd1',
      passengerId: 'p1',
      vehicleType: 'CAR',
      origin: { lat: -12, lon: -77 },
      bidCents: 800,
      reason: 'driver_cancelled',
      negotiationSeq: 2,
    };
    expect(EVENT_SCHEMAS['trip.reassigning'].safeParse(ok).success).toBe(true);
    expect(
      EVENT_SCHEMAS['trip.reassigning'].safeParse({ ...ok, reason: 'passenger_cancelled' }).success,
    ).toBe(false);
    // H13 — negotiationSeq debe ser entero positivo
    expect(EVENT_SCHEMAS['trip.reassigning'].safeParse({ ...ok, negotiationSeq: 0 }).success).toBe(
      false,
    );
    expect(EVENT_SCHEMAS['trip.reassigning'].safeParse({ ...ok, bidCents: -800 }).success).toBe(
      false,
    );
    // Sin los campos de reconstrucción del board (driverId/passengerId/vehicleType/origin) → rechazo.
    expect(
      EVENT_SCHEMAS['trip.reassigning'].safeParse({
        tripId: 't1',
        bidCents: 800,
        reason: 'driver_cancelled',
      }).success,
    ).toBe(false);
  });

  it('pricing.mode_schedule_updated: acepta snapshot válido, rechaza mode/dayMask/minuto fuera de rango (ADR 011)', () => {
    const ok: EventPayload<'pricing.mode_schedule_updated'> = {
      defaultMode: 'PUJA',
      rules: [
        // Lun-Vie (1+2+4+8+16=31), pico mañana 07:00–10:00 (420–600) → FIXED.
        { dayMask: 31, startMinute: 420, endMinute: 600, mode: 'FIXED' },
      ],
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    expect(EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse(ok).success).toBe(true);
    // rules vacío es válido (solo aplica defaultMode).
    expect(
      EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse({ ...ok, rules: [] }).success,
    ).toBe(true);
    // mode fuera del enum PricingMode.
    expect(
      EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse({ ...ok, defaultMode: 'AUCTION' })
        .success,
    ).toBe(false);
    // dayMask fuera de 1..127.
    expect(
      EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse({
        ...ok,
        rules: [{ dayMask: 0, startMinute: 0, endMinute: 60, mode: 'PUJA' }],
      }).success,
    ).toBe(false);
    // minuto del día fuera de 0..1439.
    expect(
      EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse({
        ...ok,
        rules: [{ dayMask: 1, startMinute: 0, endMinute: 1440, mode: 'PUJA' }],
      }).success,
    ).toBe(false);
    // version negativa.
    expect(
      EVENT_SCHEMAS['pricing.mode_schedule_updated'].safeParse({ ...ok, version: -1 }).success,
    ).toBe(false);
  });
});

describe('efectivo · cierre del dominó (cashCollected + payment.cash_pending)', () => {
  it('trip.completed: acepta cashCollected booleano y eventos viejos sin el campo (compat N-2)', () => {
    const base: EventPayload<'trip.completed'> = {
      tripId: '018f9a3e-1c2b-7d4e-8a1f-0123456789ab',
      fareCents: 1500,
      distanceMeters: 4200,
      durationSeconds: 600,
      paymentMethod: 'CASH',
    };
    // El conductor cobró en mano al terminar.
    expect(
      EVENT_SCHEMAS['trip.completed'].safeParse({ ...base, cashCollected: true }).success,
    ).toBe(true);
    expect(
      EVENT_SCHEMAS['trip.completed'].safeParse({ ...base, cashCollected: false }).success,
    ).toBe(true);
    // Compat N-2: un trip.completed viejo SIN el campo sigue siendo válido (undefined).
    expect(EVENT_SCHEMAS['trip.completed'].safeParse(base).success).toBe(true);
    // No es un booleano → rechazo.
    expect(
      EVENT_SCHEMAS['trip.completed'].safeParse({ ...base, cashCollected: 'si' }).success,
    ).toBe(false);
  });

  it('payment.cash_pending: acepta válido (con/sin passengerId), rechaza grossCents no-entero', () => {
    const ok: EventPayload<'payment.cash_pending'> = {
      paymentId: 'pay-1',
      tripId: 't1',
      grossCents: 1500,
      passengerId: 'p1',
    };
    expect(EVENT_SCHEMAS['payment.cash_pending'].safeParse(ok).success).toBe(true);
    // passengerId es opcional (enriquecido; ausente ⇒ el consumidor omite el push).
    const { passengerId: _p, ...sinPax } = ok;
    expect(EVENT_SCHEMAS['payment.cash_pending'].safeParse(sinPax).success).toBe(true);
    // grossCents debe ser entero (céntimos PEN).
    expect(
      EVENT_SCHEMAS['payment.cash_pending'].safeParse({ ...ok, grossCents: 15.5 }).success,
    ).toBe(false);
    // paymentId/tripId requeridos.
    expect(EVENT_SCHEMAS['payment.cash_pending'].safeParse({ grossCents: 1500 }).success).toBe(
      false,
    );
  });

  it('payment.cash_pending enruta al topic payment', () => {
    expect(topicForEvent('payment.cash_pending')).toBe('payment');
  });
});

describe('trip.child_code_failed · dominó S3 (BR-T07 modo niño)', () => {
  it('acepta el payload REAL del producer (con attempt + passengerId enriquecido)', () => {
    const ok: EventPayload<'trip.child_code_failed'> = {
      tripId: 't1',
      passengerId: 'p1',
      driverId: 'd1',
      attempt: 3,
      at: new Date().toISOString(),
    };
    expect(EVENT_SCHEMAS['trip.child_code_failed'].safeParse(ok).success).toBe(true);
  });

  it('tolera filas pre-fix SIN attempt/passengerId (anti poison pill del relay del outbox)', () => {
    // El relay publica con `schema.parse` (lanza) y drena oldest-first en UNA tx: si una fila vieja
    // sin `attempt` no pasara, bloquearía TODO el outbox de trip por head-of-line. Compat de consumo.
    expect(
      EVENT_SCHEMAS['trip.child_code_failed'].safeParse({
        tripId: 't1',
        at: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it('rechaza attempt no-entero y campos requeridos faltantes', () => {
    const at = new Date().toISOString();
    expect(
      EVENT_SCHEMAS['trip.child_code_failed'].safeParse({ tripId: 't1', attempt: 1.5, at }).success,
    ).toBe(false);
    // tripId / at siguen REQUERIDOS.
    expect(EVENT_SCHEMAS['trip.child_code_failed'].safeParse({ attempt: 1, at }).success).toBe(
      false,
    );
    expect(
      EVENT_SCHEMAS['trip.child_code_failed'].safeParse({ tripId: 't1', attempt: 1 }).success,
    ).toBe(false);
  });

  it('enruta al topic trip', () => {
    expect(topicForEvent('trip.child_code_failed')).toBe('trip');
  });
});

describe('poison · clasificación de errores de consumidor Kafka', () => {
  it('isUuid: acepta UUID canónico, rechaza no-UUID', () => {
    expect(isUuid('018f9a3e-1c2b-7d4e-8a1f-0123456789ab')).toBe(true);
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    // El veneno del incidente: ids sintéticos no-UUID.
    expect(isUuid('trip-1')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });

  it('isPermanentDataError: P2023 (UUID malformado) y otros de datos → permanente', () => {
    // El error exacto del incidente: Prisma P2023 al consultar columna @db.Uuid con string basura.
    expect(isPermanentDataError({ code: 'P2023', message: 'inconsistent column data' })).toBe(true);
    expect(isPermanentDataError({ code: 'P2009' })).toBe(true);
    expect(isPermanentDataError({ code: 'P2000' })).toBe(true);
  });

  it('isPermanentDataError: errores transitorios y desconocidos → NO permanente (se relanza)', () => {
    // DB inalcanzable / timeout / deadlock → transitorio: el evento es válido, falló el medio.
    expect(isPermanentDataError({ code: 'P1001' })).toBe(false); // can not reach DB
    expect(isPermanentDataError({ code: 'P1002' })).toBe(false); // timeout
    expect(isPermanentDataError({ code: 'P2034' })).toBe(false); // deadlock / write conflict
    expect(isPermanentDataError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isPermanentDataError('string error')).toBe(false);
    expect(isPermanentDataError(undefined)).toBe(false);
  });
});

describe('driver.location_updated · certificaciones del conductor (B5-3.2)', () => {
  const base: EventPayload<'driver.location_updated'> = {
    driverId: 'd1',
    point: { lat: -12.1, lon: -77.0 },
    h3: '8928308280fffff',
    at: new Date().toISOString(),
  };

  it('acepta un ping SIN certifications (compat: ofertas sin certs requeridas)', () => {
    expect(EVENT_SCHEMAS['driver.location_updated'].safeParse(base).success).toBe(true);
  });

  it('acepta certifications con valores del enum FleetDocumentType', () => {
    const ok = { ...base, certifications: ['AMBULANCE_OPERATOR', 'TOW_OPERATOR'] };
    expect(EVENT_SCHEMAS['driver.location_updated'].safeParse(ok).success).toBe(true);
  });

  it('rechaza una certificación fuera del enum (no es un FleetDocumentType)', () => {
    const bad = { ...base, certifications: ['HELICOPTER_PILOT'] };
    expect(EVENT_SCHEMAS['driver.location_updated'].safeParse(bad).success).toBe(false);
  });
});

/**
 * `booking.cancelled` cubre DOS formas (contrato ADITIVO, FIX 3): la cancelación de la OFERTA (PublishedTrip,
 * F1a) y la de un BOOKING individual por cobro rechazado (F3b). Estos tests CRISTALIZAN que AMBAS parsean — en
 * particular que la forma OFERTA existente sigue válida tras agregar los campos opcionales bookingId/razon.
 */
describe('booking.cancelled · contrato aditivo (oferta + booking individual)', () => {
  it('forma OFERTA (existente) sigue parseando: publishedTripId + driverId + estadoAnterior, SIN bookingId/razon', () => {
    const ofertaCancelada = {
      publishedTripId: 'pt1',
      driverId: 'd1',
      estado: 'CANCELADO',
      estadoAnterior: 'PUBLICADO',
    };
    expect(EVENT_SCHEMAS['booking.cancelled'].safeParse(ofertaCancelada).success).toBe(true);
  });

  it('forma BOOKING individual (F3b): bookingId + razon=COBRO_RECHAZADO + estadoAnterior=APROBADO parsea', () => {
    const bookingCancelado = {
      bookingId: 'b1',
      razon: 'COBRO_RECHAZADO',
      estado: 'CANCELADO',
      estadoAnterior: 'APROBADO',
    };
    expect(EVENT_SCHEMAS['booking.cancelled'].safeParse(bookingCancelado).success).toBe(true);
  });

  it('forma BOOKING individual (F3c · guard): bookingId + razon=OFERTA_NO_DISPONIBLE + estadoAnterior=COBRO_PENDIENTE parsea', () => {
    const bookingCancelado = {
      bookingId: 'b1',
      razon: 'OFERTA_NO_DISPONIBLE',
      estado: 'CANCELADO',
      estadoAnterior: 'COBRO_PENDIENTE',
    };
    expect(EVENT_SCHEMAS['booking.cancelled'].safeParse(bookingCancelado).success).toBe(true);
  });

  it('rechaza una razon fuera del enum tipado (no es un BookingCancelledRazon)', () => {
    const bad = {
      bookingId: 'b1',
      razon: 'PORQUE_SI',
      estado: 'CANCELADO',
      estadoAnterior: 'APROBADO',
    };
    expect(EVENT_SCHEMAS['booking.cancelled'].safeParse(bad).success).toBe(false);
  });

  it('rechaza estado != CANCELADO (el literal del evento)', () => {
    const bad = {
      publishedTripId: 'pt1',
      driverId: 'd1',
      estado: 'PUBLICADO',
      estadoAnterior: 'PUBLICADO',
    };
    expect(EVENT_SCHEMAS['booking.cancelled'].safeParse(bad).success).toBe(false);
  });
});
