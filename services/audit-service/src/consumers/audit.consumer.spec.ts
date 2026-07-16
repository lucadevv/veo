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
  DRIVER_OFFLINE_REASON,
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra TODAS las transiciones del ciclo de vida', () => {
    for (const t of [
      'trip.assigned',
      'trip.accepted',
      'trip.arriving',
      'trip.arrived',
      'trip.started',
      'trip.completed',
      'trip.cancelled',
      'trip.expired',
      'trip.failed',
      'trip.child_code_failed',
    ]) {
      expect(handlers.has(t), `falta handler ${t}`).toBe(true);
    }
  });

  it('SÍ audita trip.requested/bid_posted/reassigning (la geo del payload la descarta la proyección, no se excluyen)', () => {
    expect(handlers.has('trip.requested')).toBe(true);
    expect(handlers.has('trip.bid_posted')).toBe(true);
    expect(handlers.has('trip.reassigning')).toBe(true);
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
      payload: {
        tripId: 't-1',
        passengerId: 'pax-1',
        fromStatus: 'REQUESTED',
        staleMinutes: 12,
        at: new Date().toISOString(),
      },
    });
    await handlers.get('trip.expired')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping.actorId).toBe('system');
  });
});

describe('AuditConsumer · compliance crítico (cadena de custodia Ley 29733)', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra handlers para los 7 eventos de compliance', () => {
    for (const t of [
      'media.access_granted',
      'media.access_viewed',
      'media.access_rejected',
      'user.kyc_verified',
      'user.email_verified',
      'trip.pii_erased',
      'panic.resolved',
    ]) {
      expect(handlers.has(t), `falta handler ${t}`).toBe(true);
    }
  });

  it('user.email_verified → actorId=resourceId=userId, resourceType=user (confirmación de correo)', async () => {
    const envelope = createEnvelope({
      eventType: 'user.email_verified',
      producer: 'identity-service',
      payload: { userId: 'u-321', email: 'pax@veo.pe', verifiedAt: new Date().toISOString() },
    });
    await handlers.get('user.email_verified')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('user.email_verified'));
    expect(mapping).toEqual({ actorId: 'u-321', resourceType: 'user', resourceId: 'u-321' });
  });

  it('media.access_granted → actorId=operatorId, resourceType=media, resourceId=segmentId (quién vio qué video)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.access_granted',
      producer: 'media-service',
      payload: {
        requestId: 'req-1',
        tripId: 't-1',
        segmentId: 'seg-9',
        operatorId: 'op-7',
        approvedBy: 'sup-3',
        watermark: 'op-7@veo',
        expiresAt: new Date().toISOString(),
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.access_granted')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'op-7', resourceType: 'media', resourceId: 'seg-9' });
  });

  it('media.access_granted sin segmentId → resourceId cae al tripId (fallback del optional)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.access_granted',
      producer: 'media-service',
      payload: {
        requestId: 'req-2',
        tripId: 't-42',
        operatorId: 'op-7',
        approvedBy: 'sup-3',
        expiresAt: new Date().toISOString(),
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.access_granted')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'op-7', resourceType: 'media', resourceId: 't-42' });
  });

  it('media.access_viewed → actorId=viewedBy, resourceType=media, resourceId=segmentId (reproducción efectiva)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.access_viewed',
      producer: 'media-service',
      payload: {
        requestId: 'req-v1',
        tripId: 't-1',
        segmentId: 'seg-9',
        operatorId: 'op-7',
        operatorEmail: 'op-7@veo.pe',
        viewedBy: 'op-7',
        watermark: 'op-7@veo',
        expiresAt: new Date().toISOString(),
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.access_viewed')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('media.access_viewed'));
    expect(mapping).toEqual({ actorId: 'op-7', resourceType: 'media', resourceId: 'seg-9' });
  });

  it('media.access_rejected con segmentId → actorId=rejectedBy, resourceType=media, resourceId=segmentId (denegación)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.access_rejected',
      producer: 'media-service',
      payload: {
        requestId: 'req-r1',
        tripId: 't-1',
        segmentId: 'seg-9',
        operatorId: 'op-7',
        rejectedBy: 'sup-3',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.access_rejected')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('media.access_rejected'));
    expect(mapping).toEqual({ actorId: 'sup-3', resourceType: 'media', resourceId: 'seg-9' });
  });

  it('media.access_rejected SIN segmentId → resourceId cae al tripId (fallback del optional)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.access_rejected',
      producer: 'media-service',
      payload: {
        requestId: 'req-r2',
        tripId: 't-42',
        operatorId: 'op-7',
        rejectedBy: 'sup-3',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.access_rejected')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'sup-3', resourceType: 'media', resourceId: 't-42' });
  });

  it('user.kyc_verified → actorId=resourceId=userId, resourceType=user', async () => {
    const envelope = createEnvelope({
      eventType: 'user.kyc_verified',
      producer: 'identity-service',
      payload: { userId: 'u-555', kycStatus: 'APPROVED', verifiedAt: new Date().toISOString() },
    });
    await handlers.get('user.kyc_verified')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'u-555', resourceType: 'user', resourceId: 'u-555' });
  });

  it('trip.pii_erased → actorId=passengerId, resourceType=trip, resourceId=tripId (derecho al olvido)', async () => {
    const envelope = createEnvelope({
      eventType: 'trip.pii_erased',
      producer: 'trip-service',
      payload: { tripId: 't-77', passengerId: 'pax-9', at: new Date().toISOString() },
    });
    await handlers.get('trip.pii_erased')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'pax-9', resourceType: 'trip', resourceId: 't-77' });
  });

  it('panic.resolved → actorId=resolvedBy, resourceType=panic, resourceId=panicId (cierre de emergencia)', async () => {
    const envelope = createEnvelope({
      eventType: 'panic.resolved',
      producer: 'panic-service',
      // tripId/passengerId son REQUERIDOS por el schema panicResolved (enriquecido): el envelope debe
      // pasar `schema.parse` antes de mapearse. El mapping de auditoría solo usa panicId/resolvedBy.
      payload: {
        panicId: 'pn-3',
        tripId: 't-3',
        passengerId: 'pax-3',
        status: 'RESOLVED',
        resolvedBy: 'op-7',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('panic.resolved')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'op-7', resourceType: 'panic', resourceId: 'pn-3' });
  });
});

describe('AuditConsumer · recompensas/créditos (Ley 29733: traza de movimientos de dinero)', () => {
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
    const audit = { recordFromEvent } as unknown as AuditService;
    await new AuditConsumer(audit, makeConfig()).onModuleInit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra handler para el vínculo de referido creado (user.referred)', () => {
    expect(handlers.has('user.referred')).toBe(true);
  });

  it('user.referred → actor=referidor, recurso=referral/referido (vínculo creado)', async () => {
    const envelope = createEnvelope({
      eventType: 'user.referred',
      producer: 'identity-service',
      payload: {
        referrerUserId: 'u-ref',
        referredUserId: 'u-new',
        code: 'VEOABC',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('user.referred')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('user.referred'));
    expect(mapping).toEqual({ actorId: 'u-ref', resourceType: 'referral', resourceId: 'u-new' });
  });

  it('registra handlers para los 3 movimientos de crédito', () => {
    expect(handlers.has('referral.rewarded')).toBe(true);
    expect(handlers.has('promo.redeemed')).toBe(true);
    expect(handlers.has('incentive.completed')).toBe(true);
  });

  it('referral.rewarded → actor=referidor, recurso=referral/referido', async () => {
    const envelope = createEnvelope({
      eventType: 'referral.rewarded',
      producer: 'identity-service',
      payload: {
        referrerUserId: 'u-ref',
        referredUserId: 'u-new',
        rewardCents: 1500,
        tripId: 't-1',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('referral.rewarded')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'u-ref', resourceType: 'referral', resourceId: 'u-new' });
  });

  it('promo.redeemed → actor=usuario, recurso=promotion', async () => {
    const envelope = createEnvelope({
      eventType: 'promo.redeemed',
      producer: 'payment-service',
      payload: {
        promotionId: 'promo-9',
        code: 'VEO10',
        userId: 'u-7',
        tripId: 't-2',
        discountCents: 500,
        at: new Date().toISOString(),
      },
    });
    await handlers.get('promo.redeemed')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'u-7', resourceType: 'promotion', resourceId: 'promo-9' });
  });

  it('incentive.completed → actor=conductor, recurso=incentive', async () => {
    const envelope = createEnvelope({
      eventType: 'incentive.completed',
      producer: 'payment-service',
      payload: {
        incentiveId: 'inc-3',
        driverId: 'drv-5',
        rewardCents: 2000,
        tripsCompleted: 10,
        at: new Date().toISOString(),
      },
    });
    await handlers.get('incentive.completed')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'drv-5', resourceType: 'incentive', resourceId: 'inc-3' });
  });
});

describe('AuditConsumer · pagos (movimiento de dinero al WORM inmutable · Ley 29733)', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra handlers para los 3 movimientos de pago (captured/failed/refunded)', () => {
    expect(handlers.has('payment.captured')).toBe(true);
    expect(handlers.has('payment.failed')).toBe(true);
    // CAMBIO 3: la plata que VUELVE al pasajero también debe quedar en el audit inmutable (cierra el gap de
    // "movimiento de plata sin audit"). Sin este handler un refund no dejaría traza WORM como captured/failed.
    expect(handlers.has('payment.refunded')).toBe(true);
  });

  it('payment.refunded → actorId=approvedBy (quién aprobó), resourceType=payment, resourceId=paymentId', async () => {
    const envelope = createEnvelope({
      eventType: 'payment.refunded',
      producer: 'payment-service',
      payload: {
        paymentId: 'pay-9',
        tripId: 't-9',
        amountCents: 2500,
        reason: 'ASIENTO_LLENO',
        approvedBy: 'op-admin-3',
        passengerId: 'pax-9',
      },
    });
    await handlers.get('payment.refunded')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('payment.refunded'));
    expect(mapping).toEqual({
      actorId: 'op-admin-3',
      resourceType: 'payment',
      resourceId: 'pay-9',
    });
  });

  it('payment.refunded system-initiated (approvedBy=system) → actorId=system (refund automático por cancelación)', async () => {
    const envelope = createEnvelope({
      eventType: 'payment.refunded',
      producer: 'payment-service',
      payload: {
        paymentId: 'pay-sys',
        tripId: 't-sys',
        amountCents: 1800,
        approvedBy: 'system',
      },
    });
    await handlers.get('payment.refunded')!(envelope);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'system', resourceType: 'payment', resourceId: 'pay-sys' });
  });
});

describe('AuditConsumer · desembolsos (ciclo de payout al WORM inmutable · ADR-015 §4.1/§6 · Ley 29733)', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra handlers para el ciclo completo de desembolso (processing/processed/failed)', () => {
    // Regla de oro del consumer: TODOS los eventos suscritos están en handlers(); el bootstrap deriva la
    // suscripción al topic `payout` de estas keys. Sin estos handlers, processing/failed NO dejarían traza WORM.
    expect(handlers.has('payout.processing')).toBe(true);
    expect(handlers.has('payout.processed')).toBe(true);
    expect(handlers.has('payout.failed')).toBe(true);
  });

  it('payout.processing → actorId=driverId, resourceType=payout, resourceId=payoutId (disparo humano del operador)', async () => {
    const envelope = createEnvelope({
      eventType: 'payout.processing',
      producer: 'payment-service',
      payload: { payoutId: 'po-1', driverId: 'drv-9', amountCents: 45000, period: '2026-06' },
    });
    await handlers.get('payout.processing')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('payout.processing'));
    expect(mapping).toEqual({ actorId: 'drv-9', resourceType: 'payout', resourceId: 'po-1' });
  });

  it('payout.failed → actorId=driverId, resourceType=payout, resourceId=payoutId (rechazo del riel)', async () => {
    const envelope = createEnvelope({
      eventType: 'payout.failed',
      producer: 'payment-service',
      payload: { payoutId: 'po-2', driverId: 'drv-7', amountCents: 32000, period: '2026-06' },
    });
    await handlers.get('payout.failed')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('payout.failed'));
    expect(mapping).toEqual({ actorId: 'drv-7', resourceType: 'payout', resourceId: 'po-2' });
  });

  it('payout.processed → actorId=driverId, resourceType=payout, resourceId=payoutId (desembolso efectivo)', async () => {
    const envelope = createEnvelope({
      eventType: 'payout.processed',
      producer: 'payment-service',
      payload: { payoutId: 'po-3', driverId: 'drv-5', amountCents: 50000, period: '2026-06' },
    });
    await handlers.get('payout.processed')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('payout.processed'));
    expect(mapping).toEqual({ actorId: 'drv-5', resourceType: 'payout', resourceId: 'po-3' });
  });
});

describe('AuditConsumer · trazabilidad total (representativos por categoría · "todo todo")', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  const mappingOf = () =>
    (recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping])[2];

  // ── A · money ──
  it('A/money · payment.cancellation_penalty_recorded → actor=passengerId, recurso=penalty/penaltyId', async () => {
    const envelope = createEnvelope({
      eventType: 'payment.cancellation_penalty_recorded',
      producer: 'payment-service',
      payload: {
        penaltyId: 'pen-1',
        tripId: 't-1',
        passengerId: 'pax-1',
        driverId: 'drv-1',
        penaltyCents: 500,
        driverCompensationCents: 300,
        platformCents: 200,
      },
    });
    await handlers.get('payment.cancellation_penalty_recorded')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'pax-1', resourceType: 'penalty', resourceId: 'pen-1' });
  });

  // ── B · acceso (admin.role_changed) ──
  it('B/acceso · admin.role_changed → actor=changedBy, recurso=admin/adminUserId', async () => {
    const envelope = createEnvelope({
      eventType: 'admin.role_changed',
      producer: 'identity-service',
      payload: {
        adminUserId: 'adm-9',
        roles: ['PANIC_OPERATOR'],
        changedBy: 'super-1',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('admin.role_changed')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'super-1', resourceType: 'admin', resourceId: 'adm-9' });
  });

  it('B/acceso · driver.flagged (regla automática) → actor=system, recurso=driver', async () => {
    const envelope = createEnvelope({
      eventType: 'driver.flagged',
      producer: 'rating-service',
      payload: { driverId: 'drv-9', rollingAvg: 3.9, reason: 'suspension' },
    });
    await handlers.get('driver.flagged')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'system', resourceType: 'driver', resourceId: 'drv-9' });
  });

  it('B/acceso · fleet.driver_suspended por ITV (vía userId) → recurso=userId cuando no hay driverId', async () => {
    const envelope = createEnvelope({
      eventType: 'fleet.driver_suspended',
      producer: 'fleet-service',
      payload: {
        userId: 'usr-7',
        reason: 'INSPECTION_EXPIRED',
        vehicleId: 'veh-1',
        suspendedAt: new Date().toISOString(),
      },
    });
    await handlers.get('fleet.driver_suspended')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'system', resourceType: 'driver', resourceId: 'usr-7' });
  });

  // ── C · ciclo (booking.published) ──
  it('C/ciclo · booking.published → actor=driverId, recurso=published_trip/publishedTripId', async () => {
    const envelope = createEnvelope({
      eventType: 'booking.published',
      producer: 'booking-service',
      payload: {
        publishedTripId: 'pt-1',
        driverId: 'drv-1',
        vehicleId: 'veh-1',
        asientosTotales: 3,
        precioBase: 1500,
        modoReserva: 'INSTANT_BOOKING',
        fechaHoraSalida: new Date().toISOString(),
        pais: 'PE',
        moneda: 'PEN',
      },
    });
    await handlers.get('booking.published')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'drv-1',
      resourceType: 'published_trip',
      resourceId: 'pt-1',
    });
  });

  it('C/ciclo · booking.approved discrimina por origen (INSTANT→system, APROBACION_CONDUCTOR→driverId)', async () => {
    const mk = (origen: 'INSTANT_BOOKING' | 'APROBACION_CONDUCTOR') =>
      createEnvelope({
        eventType: 'booking.approved',
        producer: 'booking-service',
        payload: {
          bookingId: 'bk-1',
          publishedTripId: 'pt-1',
          passengerId: 'pax-1',
          driverId: 'drv-1',
          asientos: 1,
          precioAcordado: 1500,
          modoReserva: origen === 'INSTANT_BOOKING' ? 'INSTANT_BOOKING' : 'REVISION_CADA_SOLICITUD',
          estado: 'APROBADO',
          origen,
        },
      });
    await handlers.get('booking.approved')!(mk('INSTANT_BOOKING'));
    await handlers.get('booking.approved')!(mk('APROBACION_CONDUCTOR'));
    const actors = recordFromEvent.mock.calls.map((c) => (c[2] as EventAuditMapping).actorId);
    expect(actors).toEqual(['system', 'drv-1']);
  });

  it('C/ciclo · booking.cancelled forma A (oferta, sin bookingId) → actor=driverId, recurso=published_trip', async () => {
    const envelope = createEnvelope({
      eventType: 'booking.cancelled',
      producer: 'booking-service',
      payload: {
        publishedTripId: 'pt-9',
        driverId: 'drv-9',
        estado: 'CANCELADO',
        estadoAnterior: 'PUBLICADO',
      },
    });
    await handlers.get('booking.cancelled')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'drv-9',
      resourceType: 'published_trip',
      resourceId: 'pt-9',
    });
  });

  it('C/ciclo · booking.rejected → actor=driverId (el conductor decidió), recurso=booking/bookingId', async () => {
    const envelope = createEnvelope({
      eventType: 'booking.rejected',
      producer: 'booking-service',
      payload: {
        bookingId: 'bk-8',
        publishedTripId: 'pt-8',
        passengerId: 'pax-8',
        driverId: 'drv-8',
        estado: 'RECHAZADO',
      },
    });
    await handlers.get('booking.rejected')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'drv-8', resourceType: 'booking', resourceId: 'bk-8' });
  });

  it('C/ciclo · booking.expired (TTL sin respuesta, decisión automática) → actor=system, recurso=booking/bookingId', async () => {
    const envelope = createEnvelope({
      eventType: 'booking.expired',
      producer: 'booking-service',
      payload: {
        bookingId: 'bk-9',
        publishedTripId: 'pt-9',
        passengerId: 'pax-9',
        driverId: 'drv-9',
        estado: 'EXPIRADO',
      },
    });
    await handlers.get('booking.expired')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'system',
      resourceType: 'booking',
      resourceId: 'bk-9',
    });
  });

  it('C/ciclo · booking.cancelled forma B (booking individual, con bookingId) → actor=system, recurso=booking', async () => {
    const envelope = createEnvelope({
      eventType: 'booking.cancelled',
      producer: 'booking-service',
      payload: {
        bookingId: 'bk-7',
        razon: 'ASIENTO_LLENO',
        estado: 'CANCELADO',
        estadoAnterior: 'COBRO_PENDIENTE',
      },
    });
    await handlers.get('booking.cancelled')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'system', resourceType: 'booking', resourceId: 'bk-7' });
  });

  it('C/ciclo · pricing.mode_schedule_updated → actor=system, recurso=pricing/mode_schedule (config snapshot)', async () => {
    const envelope = createEnvelope({
      eventType: 'pricing.mode_schedule_updated',
      producer: 'admin-bff',
      payload: {
        defaultMode: 'PUJA',
        rules: [{ dayMask: 127, startMinute: 0, endMinute: 1439, mode: 'FIXED' }],
        version: 3,
        updatedAt: new Date().toISOString(),
      },
    });
    await handlers.get('pricing.mode_schedule_updated')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'system',
      resourceType: 'pricing',
      resourceId: 'mode_schedule',
    });
  });

  it('C/ciclo · dispatch.match_found → actor=driverId, recurso=dispatch/tripId (sin geo en el payload)', async () => {
    const envelope = createEnvelope({
      eventType: 'dispatch.match_found',
      producer: 'dispatch-service',
      payload: { tripId: 't-5', driverId: 'drv-5', vehicleId: 'veh-5', scoreMs: 12 },
    });
    await handlers.get('dispatch.match_found')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'drv-5', resourceType: 'dispatch', resourceId: 't-5' });
  });

  it('C/ciclo · dispatch.radius_config_updated → actor=system, recurso=dispatch/radius_config (config snapshot)', async () => {
    const envelope = createEnvelope({
      eventType: 'dispatch.radius_config_updated',
      producer: 'dispatch-service',
      payload: {
        nearbyKRing: 3,
        matchKRing: 4,
        offerTimeoutMs: 20_000,
        bidWindowSec: 60,
        policyVersion: 'v1',
        policyV2: null,
        version: 7,
        updatedAt: new Date().toISOString(),
      },
    });
    await handlers.get('dispatch.radius_config_updated')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'system',
      resourceType: 'dispatch',
      resourceId: 'radius_config',
    });
  });

  // ── D · metadato (chat SÍ se audita; el body lo descarta la proyección antes del WORM) ──
  it('D/metadato · chat.message_sent → actor=senderId, recurso=chat/tripId (el body lo dropea la proyección)', async () => {
    const envelope = createEnvelope({
      eventType: 'chat.message_sent',
      producer: 'chat-service',
      payload: {
        messageId: 'msg-1',
        tripId: 't-1',
        senderId: 'pax-1',
        senderRole: 'PASSENGER',
        body: 'texto privado',
        createdAt: new Date().toISOString(),
      },
    });
    await handlers.get('chat.message_sent')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'pax-1', resourceType: 'chat', resourceId: 't-1' });
  });

  it('D/metadato · notification.sent → actor=system, recurso=notification/notificationId', async () => {
    const envelope = createEnvelope({
      eventType: 'notification.sent',
      producer: 'notification-service',
      payload: { notificationId: 'ntf-1', channel: 'PUSH', to: 'tok-abc' },
    });
    await handlers.get('notification.sent')!(envelope);
    expect(mappingOf()).toEqual({
      actorId: 'system',
      resourceType: 'notification',
      resourceId: 'ntf-1',
    });
  });

  it('share.link_generated → actor=system, recurso=share/shareId', async () => {
    const envelope = createEnvelope({
      eventType: 'share.link_generated',
      producer: 'share-service',
      payload: { shareId: 'sh-1', tripId: 't-1', expiresAt: new Date().toISOString() },
    });
    await handlers.get('share.link_generated')!(envelope);
    expect(mappingOf()).toEqual({ actorId: 'system', resourceType: 'share', resourceId: 'sh-1' });
  });
});

describe('AuditConsumer · render del burn-in (cadena de custodia · Lote 3 · BR-S02)', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('registra handlers para media.render_completed y media.render_failed (sin estos, una falla permanente de render no deja rastro WORM)', () => {
    expect(handlers.has('media.render_completed')).toBe(true);
    expect(handlers.has('media.render_failed')).toBe(true);
  });

  it('media.render_completed → actor=system (worker), resourceType=media, resourceId=segmentId', async () => {
    const envelope = createEnvelope({
      eventType: 'media.render_completed',
      producer: 'media-service',
      payload: {
        requestId: 'req-1',
        tripId: 't-1',
        segmentId: 'seg-9',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.render_completed')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('media.render_completed'));
    expect(mapping).toEqual({ actorId: 'system', resourceType: 'media', resourceId: 'seg-9' });
  });

  it('media.render_failed → actor=system, resourceType=media, resourceId=tripId (no porta segmentId)', async () => {
    const envelope = createEnvelope({
      eventType: 'media.render_failed',
      producer: 'media-service',
      payload: {
        requestId: 'req-2',
        tripId: 't-42',
        reason: 'STORAGE_OR_RENDER_FAILED',
        at: new Date().toISOString(),
      },
    });
    await handlers.get('media.render_failed')!(envelope);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('media.render_failed'));
    expect(mapping).toEqual({ actorId: 'system', resourceType: 'media', resourceId: 't-42' });
  });
});

describe('AuditConsumer · sesión de turno del conductor (went_online/went_offline · deuda cerrada)', () => {
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
    await new AuditConsumer(
      { recordFromEvent } as unknown as AuditService,
      makeConfig(),
    ).onModuleInit();
  });

  afterEach(() => vi.restoreAllMocks());

  it('audita driver.went_online (apertura de turno) con actor=recurso=driverId, resource=driver', async () => {
    const envelope = createEnvelope({
      eventType: 'driver.went_online',
      producer: 'identity-service',
      payload: { driverId: 'drv-1', at: '2026-07-06T10:00:00.000Z' },
    });
    await handlers.get('driver.went_online')!(envelope);
    expect(recordFromEvent).toHaveBeenCalledTimes(1);
    const [, topic, mapping] = recordFromEvent.mock.calls[0] as [
      unknown,
      string,
      EventAuditMapping,
    ];
    expect(topic).toBe(topicForEvent('driver.went_online'));
    expect(mapping).toEqual({ actorId: 'drv-1', resourceType: 'driver', resourceId: 'drv-1' });
  });

  it('audita driver.went_offline reason=shift_end (fin de turno DELIBERADO → WORM)', async () => {
    const envelope = createEnvelope({
      eventType: 'driver.went_offline',
      producer: 'identity-service',
      payload: {
        driverId: 'drv-1',
        at: '2026-07-06T18:00:00.000Z',
        reason: DRIVER_OFFLINE_REASON.SHIFT_END,
      },
    });
    await handlers.get('driver.went_offline')!(envelope);
    expect(recordFromEvent).toHaveBeenCalledTimes(1);
    const [, , mapping] = recordFromEvent.mock.calls[0] as [unknown, string, EventAuditMapping];
    expect(mapping).toEqual({ actorId: 'drv-1', resourceType: 'driver', resourceId: 'drv-1' });
  });

  it('NO audita driver.went_offline reason=disconnect (caída de socket best-effort, no-op limpio)', async () => {
    const envelope = createEnvelope({
      eventType: 'driver.went_offline',
      producer: 'driver-bff',
      payload: {
        driverId: 'drv-1',
        at: '2026-07-06T18:00:00.000Z',
        reason: DRIVER_OFFLINE_REASON.DISCONNECT,
      },
    });
    await handlers.get('driver.went_offline')!(envelope);
    expect(recordFromEvent).not.toHaveBeenCalled();
  });
});
