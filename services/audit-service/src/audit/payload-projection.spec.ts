/**
 * PII-GUARD (compliance ejecutable · FOUNDATION §0.7 · Ley 29733) + proyección allowlist.
 *
 * GARANTÍA CENTRAL (el test crítico): para CADA evento de EVENT_SCHEMAS, si su payload llega CONTAMINADO con
 * campos PII (to/phone/email/name/body/geo/lat/lon/coordinates/address/walletUid/token/dni/point/origin/...),
 * el payload PROYECTADO que va al WORM NO contiene NINGÚN campo cuyo nombre matchee la denylist PII — recursivo.
 * Como el WORM es inmutable (object-lock), esto demuestra CERO PII fijada, para los ~90 eventos del catálogo.
 *
 * La proyección es SAFE-BY-DEFAULT (allowlist): un evento sin allowlist → `{}`. Por eso el guard se cumple
 * incluso para un evento futuro que nadie allowlistó: nada pasa salvo lo explícitamente seguro.
 */
import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, type EventType } from '@veo/events';
import { projectAuditPayload, isPiiFieldName } from './payload-projection';
import type { AuditEntryContent } from './chain';

/** Recorre recursivamente un valor y junta todos los NOMBRES de campo (de objetos anidados y arrays). */
function collectFieldNames(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectFieldNames(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      acc.push(key);
      collectFieldNames(v, acc);
    }
  }
  return acc;
}

/**
 * ¿Algún nombre de campo (recursivo) es PII? Usa el MISMO predicado token-based que la proyección
 * (`isPiiFieldName`), así el guard NO false-positivea `platformCents`/`commissionCents` (la plata sobrevive)
 * y la política del test es EXACTAMENTE la que aplica el código.
 */
function piiFieldsIn(payload: Record<string, unknown>): string[] {
  return collectFieldNames(payload).filter(isPiiFieldName);
}

/**
 * Payload CONTAMINADO base: el cóctel completo de PII conocida + un objeto/array anidado que esconde PII en hojas.
 * Se mergea sobre un payload neutro por evento. Si la proyección dejara pasar CUALQUIERA de estos, el guard falla.
 */
const PII_COCKTAIL: Record<string, unknown> = {
  to: '+51999888777',
  phone: '+51999888777',
  phoneMasked: '+519****8777',
  email: 'victima@correo.pe',
  name: 'Juan Perez',
  firstName: 'Juan',
  lastName: 'Perez',
  fullName: 'Juan Perez',
  body: 'mensaje privado del chat',
  dni: '70123456',
  address: 'Av. Siempre Viva 742',
  geo: { lat: -12.04, lon: -77.04 },
  lat: -12.04,
  lon: -77.04,
  lng: -77.04,
  coordinates: [-12.04, -77.04],
  originLat: -12.04,
  originLon: -77.04,
  origin: { lat: -12.04, lon: -77.04 },
  destination: { lat: -12.1, lon: -77.0 },
  point: { lat: -12.04, lon: -77.04 },
  walletUid: 'wlt-secret-uid-123',
  token: 'fcm-token-abc123',
  watermark: 'operador@veo.pe',
  shareLink: 'https://veo.pe/s/abc',
  contactIds: ['c-1', 'c-2'],
  operatorEmail: 'op@veo.pe',
  nested: { phone: '999', deep: { email: 'x@y.z' } },
};

describe('payload-projection · PII-guard (cero PII al WORM, para TODO evento de EVENT_SCHEMAS)', () => {
  it('NINGÚN evento deja pasar un campo PII tras la proyección (denylist recursiva)', () => {
    const leaks: Record<string, string[]> = {};
    for (const eventType of Object.keys(EVENT_SCHEMAS) as EventType[]) {
      // payload contaminado: cóctel PII + algunos IDs/montos seguros plausibles para ese evento.
      const dirty = {
        ...PII_COCKTAIL,
        tripId: 't-1',
        driverId: 'drv-1',
        passengerId: 'pax-1',
        userId: 'u-1',
        amountCents: 1000,
      };
      const projected = projectAuditPayload(eventType, dirty);
      const offenders = piiFieldsIn(projected);
      if (offenders.length > 0) leaks[eventType] = offenders;
    }
    expect(
      leaks,
      `eventos que filtraron PII al WORM (revisá su allowlist en payload-projection.ts): ${JSON.stringify(leaks)}`,
    ).toEqual({});
  });

  it('un eventType SIN allowlist proyecta a {} (safe-by-default, no denylist)', () => {
    expect(projectAuditPayload('evento.inexistente.futuro', PII_COCKTAIL)).toEqual({});
  });

  it('payload no-objeto (null/array/primitiva) proyecta a {} sin romper', () => {
    expect(projectAuditPayload('payment.captured', null)).toEqual({});
    expect(projectAuditPayload('payment.captured', [1, 2, 3])).toEqual({});
    expect(projectAuditPayload('payment.captured', 'string')).toEqual({});
  });

  // ── Representativos: la proyección PRESERVA lo forense y DESCARTA lo inseguro ──

  it('money · payment.captured mantiene montos/IDs y dropea PII si la hubiera', () => {
    const safe = projectAuditPayload('payment.captured', {
      paymentId: 'pay-1',
      tripId: 't-1',
      method: 'YAPE',
      grossCents: 5000,
      commissionCents: 500,
      passengerId: 'pax-1',
      // contaminación que NO debe sobrevivir:
      phone: '+51999',
      walletUid: 'wlt-x',
    });
    expect(safe).toEqual({
      paymentId: 'pay-1',
      tripId: 't-1',
      method: 'YAPE',
      grossCents: 5000,
      commissionCents: 500,
      passengerId: 'pax-1',
    });
  });

  it('geo · trip.requested mantiene IDs/fare y DESCARTA origin/destination (geo)', () => {
    const safe = projectAuditPayload('trip.requested', {
      tripId: 't-1',
      passengerId: 'pax-1',
      origin: { lat: -12, lon: -77 },
      destination: { lat: -12.1, lon: -77.1 },
      fareCents: 1500,
      childMode: false,
    });
    expect(safe).toEqual({
      tripId: 't-1',
      passengerId: 'pax-1',
      fareCents: 1500,
      childMode: false,
    });
    expect('origin' in safe).toBe(false);
    expect('destination' in safe).toBe(false);
  });

  it('chat · chat.message_sent mantiene metadato y DESCARTA el body', () => {
    const safe = projectAuditPayload('chat.message_sent', {
      messageId: 'msg-1',
      tripId: 't-1',
      senderId: 'pax-1',
      senderRole: 'PASSENGER',
      body: 'texto privado que NO debe ir al WORM',
      createdAt: '2026-06-26T00:00:00Z',
    });
    expect(safe).toEqual({
      messageId: 'msg-1',
      tripId: 't-1',
      senderId: 'pax-1',
      senderRole: 'PASSENGER',
      createdAt: '2026-06-26T00:00:00Z',
    });
    expect('body' in safe).toBe(false);
  });

  it('render · media.render_completed mantiene IDs/timestamp del burn-in (sin PII)', () => {
    const safe = projectAuditPayload('media.render_completed', {
      requestId: 'req-1',
      tripId: 't-1',
      segmentId: 'seg-9',
      at: '2026-06-26T00:00:00Z',
      // contaminación que NO debe sobrevivir si llegara:
      operatorEmail: 'op@veo.pe',
      watermark: 'VEO · op@veo.pe · req-1',
    });
    expect(safe).toEqual({
      requestId: 'req-1',
      tripId: 't-1',
      segmentId: 'seg-9',
      at: '2026-06-26T00:00:00Z',
    });
  });

  it('render · media.render_failed PRESERVA el `reason` CATEGÓRICO (enum técnico, no texto libre ni PII)', () => {
    const safe = projectAuditPayload('media.render_failed', {
      requestId: 'req-2',
      tripId: 't-42',
      reason: 'STORAGE_OR_RENDER_FAILED',
      at: '2026-06-26T00:00:00Z',
      operatorEmail: 'op@veo.pe',
    });
    expect(safe).toEqual({
      requestId: 'req-2',
      tripId: 't-42',
      reason: 'STORAGE_OR_RENDER_FAILED',
      at: '2026-06-26T00:00:00Z',
    });
    // el reason categórico SOBREVIVE (valor forense), el email NO.
    expect(safe.reason).toBe('STORAGE_OR_RENDER_FAILED');
    expect('operatorEmail' in safe).toBe(false);
  });

  it('notification · notification.sent DESCARTA el `to` (token/teléfono/email crudo), deja id+canal', () => {
    const safe = projectAuditPayload('notification.sent', {
      notificationId: 'ntf-1',
      channel: 'SMS',
      to: '+51999888777',
    });
    expect(safe).toEqual({ notificationId: 'ntf-1', channel: 'SMS' });
    expect('to' in safe).toBe(false);
  });

  it('panic.fanout_requested DESCARTA geo/contactIds/shareLink, deja los IDs', () => {
    const safe = projectAuditPayload('panic.fanout_requested', {
      panicId: 'pn-1',
      tripId: 't-1',
      passengerId: 'pax-1',
      geo: { lat: -12, lon: -77 },
      contactIds: ['c-1', 'c-2'],
      shareLink: 'https://veo.pe/s/x',
    });
    expect(safe).toEqual({ panicId: 'pn-1', tripId: 't-1', passengerId: 'pax-1' });
  });

  // ── REGRESIÓN del bug de substring (ALTA #2): los *Cents NO se pueden perder por 'lat' ⊂ 'pLATformCents' ──
  it('LA PLATA SOBREVIVE · penalty_recorded conserva platformCents/driverCompensationCents/penaltyCents', () => {
    const safe = projectAuditPayload('payment.cancellation_penalty_recorded', {
      penaltyId: 'pen-1',
      tripId: 't-1',
      passengerId: 'pax-1',
      driverId: 'drv-1',
      penaltyCents: 500,
      driverCompensationCents: 300,
      platformCents: 200,
    });
    // platformCents (token ['platform','cents']) NO debe caer por el token 'lat' → la plata queda íntegra.
    expect(safe).toEqual({
      penaltyId: 'pen-1',
      tripId: 't-1',
      passengerId: 'pax-1',
      driverId: 'drv-1',
      penaltyCents: 500,
      driverCompensationCents: 300,
      platformCents: 200,
    });
  });

  it('LA PLATA SOBREVIVE · todos los *Cents pasan la proyección (no false-positive por substring)', () => {
    for (const field of [
      'grossCents',
      'commissionCents',
      'platformCents',
      'driverCompensationCents',
      'penaltyCents',
      'tipCents',
      'amountCents',
    ]) {
      expect(isPiiFieldName(field), `${field} NO es PII (la plata debe sobrevivir)`).toBe(false);
    }
    // y los que SÍ son PII se siguen detectando (token completo):
    for (const field of ['lat', 'lon', 'originLat', 'phoneNumber', 'geoPoint', 'walletUid']) {
      expect(isPiiFieldName(field), `${field} ES PII`).toBe(true);
    }
  });
});

/**
 * PII-GUARD por VALOR LIBRE (ALTA · reason free-text): el riesgo no es el NOMBRE del campo sino su VALOR
 * (un `z.string` libre que un operador/usuario tipea puede traer PII: "contactar a Juan Perez +51999..").
 * El fix es por CURACIÓN del allowlist: un campo de texto libre NO se allowlistea. Acá inyectamos un valor
 * con PII real en esos campos y aseramos que NO sobreviven a la proyección (en AMBOS carriles: evento + sync).
 * Y verificamos que los reason-ENUM (tipados, acotados) SÍ sobreviven (no se rompió lo forense seguro).
 */
describe('payload-projection · PII-guard por VALOR (texto libre fuera del allowlist)', () => {
  const PII_TEXT = 'contactar a Juan Perez +51 999 888 777, dni 70123456';

  it('reason z.string LIBRE NO sobrevive en los eventos de rejection/suspension/refund/cancel', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['driver.rejected', { driverId: 'd', userId: 'u', reason: PII_TEXT, rejectedAt: 'x' }],
      ['driver.suspended', { driverId: 'd', reason: PII_TEXT, suspendedAt: 'x' }],
      [
        'biometric.enroll_rejected',
        { driverId: 'd', userId: 'u', reason: PII_TEXT, score: 0.1, at: 'x' },
      ],
      ['trip.cancelled', { tripId: 't', by: 'PASSENGER', reason: PII_TEXT, penaltyCents: 0 }],
      ['payment.failed', { paymentId: 'p', tripId: 't', reason: PII_TEXT, willRetry: false }],
      [
        'payment.refunded',
        { paymentId: 'p', tripId: 't', amountCents: 100, reason: PII_TEXT, approvedBy: 'op' },
      ],
      ['fleet.driver_suspended', { driverId: 'd', reason: PII_TEXT, suspendedAt: 'x' }],
      ['fleet.vehicle_suspended', { vehicleId: 'v', reason: PII_TEXT, suspendedAt: 'x' }],
    ];
    for (const [eventType, payload] of cases) {
      const safe = projectAuditPayload(eventType, payload);
      expect('reason' in safe, `${eventType} filtró reason free-text al WORM`).toBe(false);
      expect(JSON.stringify(safe).includes('Juan Perez'), `${eventType} filtró el VALOR PII`).toBe(
        false,
      );
    }
  });

  it('otros z.string LIBRES fuera del allowlist: kycStatus/fromStatus/documentType/make/model/plate/pais/period/estadoAnterior', () => {
    expect(
      projectAuditPayload('user.kyc_verified', {
        userId: 'u',
        kycStatus: PII_TEXT,
        verifiedAt: 'x',
      }),
    ).toEqual({
      userId: 'u',
      verifiedAt: 'x',
    });
    expect(
      projectAuditPayload('trip.expired', {
        tripId: 't',
        passengerId: 'p',
        fromStatus: PII_TEXT,
        staleMinutes: 5,
        at: 'x',
      }),
    ).toEqual({
      tripId: 't',
      passengerId: 'p',
      staleMinutes: 5,
      at: 'x',
    });
    expect(
      projectAuditPayload('fleet.document_expired', {
        documentId: 'd',
        ownerType: 'DRIVER',
        ownerId: 'o',
        documentType: PII_TEXT,
        expiresAt: 'x',
        critical: true,
      }),
    ).toEqual({
      documentId: 'd',
      ownerType: 'DRIVER',
      ownerId: 'o',
      expiresAt: 'x',
      critical: true,
    });
    expect(
      projectAuditPayload('fleet.vehicle_registered', {
        vehicleId: 'v',
        driverId: 'd',
        plate: 'ABC-123',
        vehicleType: 'CAR',
        registeredAt: 'x',
      }),
    ).toEqual({
      vehicleId: 'v',
      driverId: 'd',
      vehicleType: 'CAR',
      registeredAt: 'x',
    });
    expect(
      projectAuditPayload('fleet.vehicle_model_reviewed', {
        modelId: 'm',
        requestedBy: 'u',
        verdict: 'APPROVED',
        make: 'Toyota',
        model: 'Yaris',
        reviewedAt: 'x',
      }),
    ).toEqual({
      modelId: 'm',
      requestedBy: 'u',
      verdict: 'APPROVED',
      reviewedAt: 'x',
    });
    expect(
      projectAuditPayload('booking.published', {
        publishedTripId: 'pt',
        driverId: 'd',
        vehicleId: 'v',
        asientosTotales: 3,
        precioBase: 1500,
        modoReserva: 'INSTANT_BOOKING',
        fechaHoraSalida: 'x',
        pais: 'PE',
        moneda: 'PEN',
      }),
    ).toEqual({
      publishedTripId: 'pt',
      driverId: 'd',
      vehicleId: 'v',
      asientosTotales: 3,
      precioBase: 1500,
      modoReserva: 'INSTANT_BOOKING',
      fechaHoraSalida: 'x',
    });
    expect(
      projectAuditPayload('payout.processed', {
        payoutId: 'po',
        driverId: 'd',
        amountCents: 5000,
        period: '2026-06',
      }),
    ).toEqual({
      payoutId: 'po',
      driverId: 'd',
      amountCents: 5000,
    });
    expect(
      projectAuditPayload('notification.failed', {
        notificationId: 'n',
        channel: PII_TEXT,
        error: PII_TEXT,
      }),
    ).toEqual({
      notificationId: 'n',
    });
  });

  it('reason-ENUM (tipado/acotado) SÍ sobrevive — no se rompió lo forense seguro', () => {
    // driver.flagged: reason = flagReasonSchema (review/suspension/reverification)
    expect(
      projectAuditPayload('driver.flagged', {
        driverId: 'd',
        rollingAvg: 3.9,
        reason: 'suspension',
      }),
    ).toEqual({
      driverId: 'd',
      rollingAvg: 3.9,
      reason: 'suspension',
    });
    // dispatch.no_offers: reason = z.enum(window_expired/all_lapsed/no_candidates)
    expect(
      projectAuditPayload('dispatch.no_offers', { tripId: 't', reason: 'window_expired' }),
    ).toEqual({
      tripId: 't',
      reason: 'window_expired',
    });
    // trip.reassigning: reason = z.enum(['driver_cancelled'])
    expect(
      projectAuditPayload('trip.reassigning', {
        tripId: 't',
        driverId: 'd',
        passengerId: 'p',
        vehicleType: 'CAR',
        bidCents: 1000,
        reason: 'driver_cancelled',
        negotiationSeq: 2,
      }).reason,
    ).toBe('driver_cancelled');
    // panic.resolved: status = z.enum(RESOLVED/FALSE_ALARM); booking.approved: origen = z.enum
    expect(
      projectAuditPayload('panic.resolved', {
        panicId: 'pn',
        tripId: 't',
        passengerId: 'p',
        status: 'RESOLVED',
        resolvedBy: 'op',
        at: 'x',
      }).status,
    ).toBe('RESOLVED');
    expect(
      projectAuditPayload('booking.approved', {
        bookingId: 'b',
        publishedTripId: 'pt',
        passengerId: 'p',
        driverId: 'd',
        asientos: 1,
        precioAcordado: 1500,
        modoReserva: 'INSTANT_BOOKING',
        estado: 'APROBADO',
        origen: 'INSTANT_BOOKING',
      }).origen,
    ).toBe('INSTANT_BOOKING');
  });

  it('los nombres de campo de texto libre están en la denylist (defensa en profundidad)', () => {
    for (const field of [
      'note',
      'comment',
      'description',
      'subject',
      'text',
      'remarks',
      'body',
      'plate',
    ]) {
      expect(isPiiFieldName(field), `${field} debe estar en la denylist de texto libre`).toBe(true);
    }
    // pero los IDs/enum NO caen (no romper messageId con el token 'message', ni reason-enum):
    for (const field of ['messageId', 'reason', 'status', 'channel', 'documentId', 'modelId']) {
      expect(isPiiFieldName(field), `${field} NO debe ser denylisted`).toBe(false);
    }
  });
});

/**
 * PII-GUARD del carril SÍNCRONO (recordSync · ALTA #3): el bypass crítico cerrado en fix #1. Ejerce
 * `AuditService.recordSync` con un repo FAKE que captura el `content` que llega a `appendEntry`, e inyecta
 * payloads PII reales de los callers (operator.create con {email}, payment.refund/media.access con {reason}).
 * Asierta que el payload PERSISTIDO NO tiene PII (proyectado por action), demostrando que el WORM no la fija.
 */
describe('AuditService.recordSync · PII-guard del carril síncrono (gRPC Record / POST /audit)', () => {
  // import perezoso para no acoplar el spec de proyección pura al servicio + sus deps de Nest/observabilidad.
  const loadService = async () => {
    const { AuditService } = await import('./audit.service');
    const captured: AuditEntryContent[] = [];
    const repo = {
      appendEntry: async (content: AuditEntryContent) => {
        captured.push(content);
        return {
          created: true,
          entry: {
            id: 'a-1',
            seq: 1n,
            eventId: 'e-1',
            actorId: content.actorId,
            action: content.action,
            resourceType: content.resourceType,
            resourceId: content.resourceId,
            ip: content.ip,
            userAgent: content.userAgent,
            occurredAt: new Date(content.occurredAt),
            payload: content.payload,
            prevHash: null,
            hash: 'h',
            s3ObjectKey: null,
            createdAt: new Date(),
          },
        };
      },
    };
    // El AuditService solo usa repo.appendEntry en recordSync; el resto de métodos del repo no se tocan acá.
    const service = new AuditService(
      repo as unknown as ConstructorParameters<typeof AuditService>[0],
    );
    return { service, captured };
  };

  it('operator.create · el EMAIL del operador NO llega al WORM (queda solo roles)', async () => {
    const { service, captured } = await loadService();
    await service.recordSync({
      actorId: 'admin-1',
      action: 'operator.create',
      resourceType: 'admin_user',
      resourceId: 'op-9',
      payload: { email: 'operador@veo.pe', roles: ['PANIC_OPERATOR'] },
      ip: '10.0.0.1',
      userAgent: 'admin-bff',
    });
    const persisted = captured[0]!.payload;
    expect(piiFieldsIn(persisted)).toEqual([]);
    expect('email' in persisted).toBe(false);
    expect(persisted).toEqual({ roles: ['PANIC_OPERATOR'] });
  });

  it('payment.refund · el `reason` free-text NO llega al WORM (quedan tripId + amountCents)', async () => {
    const { service, captured } = await loadService();
    await service.recordSync({
      actorId: 'admin-1',
      action: 'payment.refund',
      resourceType: 'payment',
      resourceId: 'pay-9',
      payload: { tripId: 't-1', amountCents: 2500, reason: 'cliente: Juan Perez +51999, fraude' },
      ip: '10.0.0.1',
      userAgent: 'admin-bff',
    });
    const persisted = captured[0]!.payload;
    expect('reason' in persisted).toBe(false);
    expect(persisted).toEqual({ tripId: 't-1', amountCents: 2500 });
  });

  it('media.access_request · el `reason` free-text NO llega al WORM (queda tripId)', async () => {
    const { service, captured } = await loadService();
    await service.recordSync({
      actorId: 'admin-1',
      action: 'media.access_request',
      resourceType: 'media_access',
      resourceId: 'req-1',
      payload: { tripId: 't-1', reason: 'investigación caso pax Maria, dni 70123456' },
      ip: '10.0.0.1',
      userAgent: 'admin-bff',
    });
    const persisted = captured[0]!.payload;
    expect('reason' in persisted).toBe(false);
    expect(persisted).toEqual({ tripId: 't-1' });
  });

  it('una action síncrona DESCONOCIDA cae al default vacío (safe-by-default, no bypass)', async () => {
    const { service, captured } = await loadService();
    await service.recordSync({
      actorId: 'admin-1',
      action: 'accion.nueva.sin.allowlist',
      resourceType: 'x',
      resourceId: 'y',
      payload: { email: 'x@y.z', phone: '+51999', secretNote: 'pii libre' },
      ip: '10.0.0.1',
      userAgent: 'admin-bff',
    });
    expect(captured[0]!.payload).toEqual({});
  });
});
