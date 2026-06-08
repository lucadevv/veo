/**
 * EventConsumerService — consume eventos de dominio y dispara notificaciones REALES vía el motor.
 *
 * Decisión de contratos (destinatarios):
 *  Este servicio NO accede a tablas de otros dominios. Los destinatarios (teléfonos de contactos de
 *  confianza, tokens push del pasajero, URLs de la central) deben viajar en el payload del evento
 *  (campos opcionales "enriquecidos" que el productor añade) o resolverse por gRPC al servicio dueño.
 *  En dev asumimos que el productor enriquece el evento. Si faltan, se registra el gap y se omite el
 *  envío de ese destinatario (sin romper el resto). Ver docs/events.md → "Gaps de contrato".
 *
 * Idempotencia: cada notificación derivada lleva dedupKey determinista (Kafka es at-least-once).
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  createKafka,
  KafkaEventConsumer,
  isUuid,
  isPermanentDataError,
  type EventEnvelope,
} from '@veo/events';
import { NotificationChannel } from '@veo/shared-types';
import { NotificationEngine } from '../engine/notification.engine';
import { NotificationPriority } from '../engine/types';
import { TEMPLATE_KEYS } from '../engine/template.catalog';
import { DeviceTokenRepository, type DeviceTarget } from '../devices/device-token.repository';
import type { Env } from '../config/env.schema';

const MAX_TRUSTED_CONTACTS = 4; // BR-S05

const contactSchema = z.object({ name: z.string().optional(), phone: z.string().min(1) });

const panicSchema = z.object({
  panicId: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  geo: z.object({ lat: z.number(), lon: z.number() }),
  // Enriquecidos (opcionales): destinatarios reales.
  contacts: z.array(contactSchema).optional(),
  shareLink: z.string().optional(),
  centralWebhookUrl: z.string().optional(),
});

const tripAssignedSchema = z.object({
  tripId: z.string(),
  driverId: z.string(),
  vehicleId: z.string(),
  // Enriquecidos (opcionales).
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  driverName: z.string().optional(),
  vehiclePlate: z.string().optional(),
  etaSeconds: z.number().optional(),
});

/**
 * #1 · trip.bid_posted con `scheduled=true` = una RESERVA se activó (cron) y abrió el board de puja.
 * El pasajero NO está en la app → push con deep-link al board. Solo nos interesa el `scheduled`; el resto
 * del payload (bidCents/origin/etc.) es para dispatch, lo ignoramos. `passengerId` resuelve el token del
 * device-store si el evento no lo enriquece.
 */
const tripBidPostedSchema = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  scheduled: z.boolean().optional(),
  // Enriquecidos (opcionales): destino real del push del pasajero.
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/**
 * H3 · trip.reassigning = el conductor canceló DESPUÉS de aceptar y el viaje re-abre la puja. Si el
 * pasajero no está en la app, sin push se entera tarde (abandono percibido). Deep-link al board re-abierto.
 */
const tripReassigningSchema = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  driverId: z.string().optional(),
  // Enriquecidos (opcionales): destino real del push del pasajero.
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/** H3 · trip.completed = cierre del viaje → push de recibo. `passengerId` viaja en el evento (lo enriquece trip). */
const tripCompletedSchema = z.object({
  tripId: z.string(),
  passengerId: z.string().optional(),
  fareCents: z.number().int().optional(),
  // Enriquecidos (opcionales): destino real del push del pasajero.
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

const tripExpiredSchema = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  fromStatus: z.string(),
  driverId: z.string().optional(),
  staleMinutes: z.number().int(),
  at: z.string(),
  // Enriquecidos (opcionales): destino real del push del pasajero.
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

const tripFailedSchema = z.object({
  tripId: z.string(),
  passengerId: z.string(),
  fromStatus: z.string(),
  driverId: z.string().optional(),
  staleMinutes: z.number().int(),
  at: z.string(),
  // Enriquecidos (opcionales): destino real del push del pasajero.
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

const paymentFailedSchema = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  reason: z.string(),
  willRetry: z.boolean(),
  // Enriquecidos (opcionales).
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  centralWebhookUrl: z.string().optional(),
});

/**
 * Flujo crítico del PASAJERO (push de estado del viaje). `passengerId` viaja ENRIQUECIDO desde
 * trip-service (lo añade al outbox de cada transición); resuelve el token del device-store si el
 * evento no trae el token directo. `driverName` opcional para personalizar el copy.
 */
const tripAcceptedSchema = z.object({
  tripId: z.string(),
  driverId: z.string(),
  etaSeconds: z.number().int(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  driverName: z.string().optional(),
});

const tripStartedSchema = z.object({
  tripId: z.string(),
  driverId: z.string(),
  startedAt: z.string(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

const tripArrivingSchema = z.object({
  tripId: z.string(),
  driverId: z.string(),
  etaSeconds: z.number().int(),
  at: z.string(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  driverName: z.string().optional(),
});

const tripArrivedSchema = z.object({
  tripId: z.string(),
  driverId: z.string(),
  at: z.string(),
  // Ventana de espera del conductor (segundos), si el dominio la modela. Hoy no se emite (gap honesto):
  // el push la incluye SOLO si viaja. No la inventamos.
  waitWindowSeconds: z.number().int().optional(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  driverName: z.string().optional(),
});

/**
 * trip.cancelled → confirmación HONESTA al pasajero. `by` decide el copy. El cancel del conductor
 * POST-accept NO llega acá (trip emite trip.reassigning, ya manejado) → sin doble push.
 */
const tripCancelledSchema = z.object({
  tripId: z.string(),
  by: z.enum(['PASSENGER', 'DRIVER', 'SYSTEM']),
  reason: z.string().optional(),
  penaltyCents: z.number().int().optional(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/** payment.captured → "pago confirmado · S/X.XX". El monto viene en grossCents. */
const paymentCapturedSchema = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  method: z.enum(['YAPE', 'PLIN', 'CASH', 'CARD', 'PAGOEFECTIVO']),
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/**
 * payment.cash_pending → "confirma tu pago en efectivo de S/X". EFECTIVO (decisión del dueño): el
 * conductor ya confirmó "cobré" al terminar (driverConfirmed); falta SOLO la confirmación del PASAJERO
 * para capturar. Empujamos al PASAJERO para que confirme. El conductor NO necesita push (ya confirmó al
 * terminar). El monto a confirmar es grossCents. `passengerId` enriquecido → token del device-store.
 */
const paymentCashPendingSchema = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  grossCents: z.number().int(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/** payment.refunded → "te devolvimos S/X.XX". El monto reembolsado es amountCents. */
const paymentRefundedSchema = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  amountCents: z.number().int(),
  reason: z.string().optional(),
  approvedBy: z.string(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/** payment.affiliation_activated / _expired → el destinatario (userId) viaja directo en el evento. */
const affiliationActivatedSchema = z.object({
  affiliationId: z.string(),
  userId: z.string(),
  wallet: z.enum(['YAPE']),
  phoneMasked: z.string().optional(),
  at: z.string(),
});

const affiliationExpiredSchema = z.object({
  affiliationId: z.string(),
  userId: z.string(),
  wallet: z.enum(['YAPE']),
  at: z.string(),
});

/**
 * chat.message_sent → push al DESTINATARIO. No hay presencia (online/offline) en el sistema: el push
 * se manda SIEMPRE, con dedup por messageId. Decisión MINIMAL: solo pushamos al PASAJERO cuando escribe
 * el conductor (senderRole=DRIVER) y el evento trae passengerId enriquecido. El caso inverso (avisar al
 * conductor) queda como decisión de producto pendiente.
 */
const chatMessageSentSchema = z.object({
  messageId: z.string(),
  tripId: z.string(),
  senderId: z.string(),
  senderRole: z.enum(['PASSENGER', 'DRIVER']),
  body: z.string(),
  createdAt: z.string(),
  passengerId: z.string().optional(),
  passengerPushToken: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
});

/** Formatea céntimos PEN a "X.XX" (S/ lo pone el template). 1850 → "18.50". */
function formatSoles(cents: number): string {
  return (cents / 100).toFixed(2);
}

@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventConsumerService.name);
  private readonly consumer: KafkaEventConsumer;
  private readonly centralWebhookUrl?: string;

  constructor(
    private readonly engine: NotificationEngine,
    private readonly devices: DeviceTokenRepository,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'notification-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'notification-service',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'notification-service');
    this.centralWebhookUrl = config.get<string>('CENTRAL_ALERT_WEBHOOK_URL');
  }

  /**
   * Resuelve los destinos de push: prioriza el token enriquecido en el evento; si no llega,
   * busca los dispositivos registrados del usuario en el almacén. Devuelve [] si no hay ninguno.
   */
  private async resolvePushTargets(
    userId: string | undefined,
    token?: string,
    platform?: 'android' | 'ios',
  ): Promise<DeviceTarget[]> {
    if (token) return [{ token, platform: platform ?? 'android' }];
    if (!userId) return [];
    return this.devices.findActiveByUser(userId);
  }

  /**
   * Igual que resolvePushTargets pero con POISON-GUARD (handlers del flujo crítico que tocan el
   * device-store con un `userId` del evento):
   *  - isUuid: un `userId`/`passengerId` no-UUID iría a una columna `@db.Uuid` → Prisma P2023 →
   *    crash-loop. Lo descartamos en el borde SIN tocar la DB (log + []).
   *  - isPermanentDataError: si el store igual lanza un error PERMANENTE de datos (P2023/P2009…), lo
   *    tratamos como veneno (log + []), NO relanzamos. Lo transitorio (DB caída) SÍ se relanza (Kafka
   *    reintenta el evento). dedup en el engine ⇒ el reintento no duplica el push.
   */
  private async safeResolveTargets(
    eventType: string,
    userId: string | undefined,
    token?: string,
    platform?: 'android' | 'ios',
  ): Promise<DeviceTarget[]> {
    if (token) return [{ token, platform: platform ?? 'android' }];
    if (!userId) return [];
    if (!isUuid(userId)) {
      this.logger.error(`POISON ${eventType}: userId no-UUID "${userId}"; push descartado sin reintento`);
      return [];
    }
    try {
      return await this.devices.findActiveByUser(userId);
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error({ err }, `POISON ${eventType}: error permanente al resolver token de ${userId}; descartado`);
        return [];
      }
      throw err; // transitorio → relanza para que Kafka reintente (dedup en el engine evita duplicar)
    }
  }

  async onModuleInit(): Promise<void> {
    this.consumer
      .on('panic.triggered', (e) => this.onPanic(e))
      .on('trip.assigned', (e) => this.onTripAssigned(e))
      .on('trip.accepted', (e) => this.onTripAccepted(e))
      .on('trip.started', (e) => this.onTripStarted(e))
      .on('trip.arriving', (e) => this.onTripArriving(e))
      .on('trip.arrived', (e) => this.onTripArrived(e))
      .on('trip.bid_posted', (e) => this.onBidPosted(e))
      .on('trip.reassigning', (e) => this.onReassigning(e))
      .on('trip.completed', (e) => this.onCompleted(e))
      .on('trip.cancelled', (e) => this.onTripCancelled(e))
      .on('trip.expired', (e) => this.onTripExpired(e))
      .on('trip.failed', (e) => this.onTripFailed(e))
      .on('payment.failed', (e) => this.onPaymentFailed(e))
      .on('payment.captured', (e) => this.onPaymentCaptured(e))
      .on('payment.cash_pending', (e) => this.onPaymentCashPending(e))
      .on('payment.refunded', (e) => this.onPaymentRefunded(e))
      .on('payment.affiliation_activated', (e) => this.onAffiliationActivated(e))
      .on('payment.affiliation_expired', (e) => this.onAffiliationExpired(e))
      .on('chat.message_sent', (e) => this.onChatMessageSent(e));
    await this.consumer.start();
    this.logger.log(
      'Consumidores activos: panic.triggered, trip.assigned, trip.accepted, trip.started, trip.arriving, ' +
        'trip.arrived, trip.bid_posted, trip.reassigning, trip.completed, trip.cancelled, trip.expired, ' +
        'trip.failed, payment.failed, payment.captured, payment.cash_pending, payment.refunded, ' +
        'payment.affiliation_activated, payment.affiliation_expired, chat.message_sent',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  /** BR-S05: SMS + link a hasta 4 contactos de confianza + alerta (webhook firmado) a la central. */
  private async onPanic(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = panicSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;

    const contacts = (p.contacts ?? []).slice(0, MAX_TRUSTED_CONTACTS);
    if (contacts.length === 0) {
      this.logger.warn(`panic ${p.panicId}: sin contactos en el evento (gap de contrato) → SMS omitidos`);
    }
    for (const contact of contacts) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.SMS,
        template: TEMPLATE_KEYS.PANIC_CONTACT_ALERT,
        // SAFETY: el pánico drena ANTES que cualquier transaccional/broadcast (SLA fan-out p99 < 3s).
        priority: NotificationPriority.Critical,
        dedupKey: `panic:${p.panicId}:sms:${contact.phone}`,
        payload: {
          to: contact.phone,
          vars: {
            name: contact.name ?? '',
            shareLink: p.shareLink ?? '',
            lat: p.geo.lat,
            lon: p.geo.lon,
          },
        },
      });
    }

    const centralUrl = p.centralWebhookUrl ?? this.centralWebhookUrl;
    if (!centralUrl) {
      this.logger.warn(`panic ${p.panicId}: sin URL de central → alerta central omitida`);
      return;
    }
    await this.engine.enqueue({
      recipientId: 'central',
      channel: NotificationChannel.WEBHOOK,
      template: TEMPLATE_KEYS.PANIC_CENTRAL_ALERT,
      priority: NotificationPriority.Critical,
      dedupKey: `panic:${p.panicId}:central`,
      payload: {
        to: centralUrl,
        vars: { panicId: p.panicId, tripId: p.tripId, passengerId: p.passengerId },
        panicId: p.panicId,
        tripId: p.tripId,
        passengerId: p.passengerId,
        geo: p.geo,
      },
    });
  }

  /** trip.assigned → push al pasajero (token del evento o, si falta, los del almacén). */
  private async onTripAssigned(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripAssignedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: sin token push del pasajero (evento ni almacén) → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_ASSIGNED,
        dedupKey: `trip:${p.tripId}:assigned:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {
            driverName: p.driverName ?? 'tu conductor',
            vehiclePlate: p.vehiclePlate ?? '',
            etaMinutes: p.etaSeconds ? Math.round(p.etaSeconds / 60) : '',
          },
          data: { tripId: p.tripId, driverId: p.driverId },
        },
      });
    }
  }

  /**
   * #1 · trip.bid_posted(scheduled=true) → push al pasajero con deep-link al BOARD. Cierra el dead-end de
   * la PUJA programada: la reserva se activa sola (cron), el board se abre, pero el pasajero no está en la
   * app → sin esto el board se llenaba de ofertas que nadie veía y expiraba. Solo `scheduled`; la puja
   * inmediata y el rebid (scheduled=false) NO pushean (el pasajero ya está mirando el board).
   */
  private async onBidPosted(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripBidPostedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    if (!p.scheduled) return; // puja inmediata / rebid: el pasajero ya está en el board.
    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: puja programada activada sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_SCHEDULED_READY,
        dedupKey: `trip:${p.tripId}:scheduled_ready:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          // Deep-link: la app navega al board de la puja al tocar el push (resolveDeepLink).
          data: { tripId: p.tripId, screen: 'OffersBoard' },
        },
      });
    }
  }

  /**
   * H3 · trip.reassigning → push al pasajero: "tu conductor canceló, volvé a elegir". Deep-link al board
   * re-abierto. Cierra el caso de abandono percibido cuando el pasajero no está mirando la app.
   */
  private async onReassigning(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripReassigningSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: reasignación sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_REASSIGNING,
        // negociationSeq no entra al dedup: una reasignación = un push; redeliveries del mismo evento dedup.
        dedupKey: `trip:${p.tripId}:reassigning:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId, screen: 'OffersBoard' },
        },
      });
    }
  }

  /**
   * H3 · trip.completed → push de RECIBO al pasajero. Deep-link al detalle del viaje. Si el evento no
   * trae passengerId (compat), se omite honesto. `screen:'TripActive'` = el detalle muestra el estado final.
   */
  private async onCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripCompletedSchema.safeParse(envelope.payload);
    if (!parsed.success || !parsed.data.passengerId) return;
    const p = parsed.data;
    const passengerId = p.passengerId!;
    const targets = await this.resolvePushTargets(passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: completado sin token push del pasajero → recibo omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_COMPLETED,
        dedupKey: `trip:${p.tripId}:completed:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId, screen: 'TripActive' },
        },
      });
    }
  }

  /**
   * trip.expired → push HONESTO al pasajero: la puja no encontró conductor / venció la ventana de
   * ofertas. No hubo viaje ⇒ payment NO cobra. "Degradación honesta": el pasajero SIEMPRE se entera.
   */
  private async onTripExpired(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripExpiredSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: expirado sin token push del pasajero (evento ni almacén) → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_EXPIRED,
        dedupKey: `trip:${p.tripId}:expired:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId },
        },
      });
    }
  }

  /**
   * trip.failed → push HONESTO al pasajero: el viaje no pudo completarse (cap de reasignación
   * superado / viaje abandonado). "Degradación honesta": el pasajero SIEMPRE se entera y se le
   * confirma que no se le cobró.
   */
  private async onTripFailed(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripFailedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: fallido sin token push del pasajero (evento ni almacén) → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_FAILED,
        dedupKey: `trip:${p.tripId}:failed:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId },
        },
      });
    }
  }

  /** payment.failed → alerta a la central y al pasajero (BR-P02). */
  private async onPaymentFailed(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = paymentFailedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;

    const targets = await this.resolvePushTargets(p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`payment ${p.paymentId}: sin token push del pasajero (evento ni almacén)`);
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_FAILED,
        dedupKey: `payment:${p.paymentId}:passenger:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { reason: p.reason },
          data: { tripId: p.tripId, paymentId: p.paymentId },
        },
      });
    }

    const centralUrl = p.centralWebhookUrl ?? this.centralWebhookUrl;
    if (centralUrl) {
      await this.engine.enqueue({
        recipientId: 'central',
        channel: NotificationChannel.WEBHOOK,
        template: TEMPLATE_KEYS.PAYMENT_CENTRAL_ALERT,
        dedupKey: `payment:${p.paymentId}:central`,
        payload: {
          to: centralUrl,
          vars: { paymentId: p.paymentId, tripId: p.tripId, reason: p.reason },
          paymentId: p.paymentId,
          tripId: p.tripId,
          reason: p.reason,
          willRetry: p.willRetry,
        },
      });
    }
  }

  /** trip.accepted → push al pasajero: "tu conductor confirmó". Deep-link al viaje activo. */
  private async onTripAccepted(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripAcceptedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('trip.accepted', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: aceptado sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_ACCEPTED,
        dedupKey: `trip:${p.tripId}:accepted:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {
            driverName: p.driverName ?? 'Tu conductor',
            etaMinutes: p.etaSeconds ? Math.round(p.etaSeconds / 60) : '',
          },
          data: { tripId: p.tripId, driverId: p.driverId, screen: 'TripActive' },
        },
      });
    }
  }

  /** trip.started → push al pasajero: "tu viaje empezó" (dispara el dominó de compartir/familia). */
  private async onTripStarted(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripStartedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('trip.started', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: iniciado sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_STARTED,
        dedupKey: `trip:${p.tripId}:started:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId, screen: 'TripActive' },
        },
      });
    }
  }

  /** trip.arriving → push al pasajero: "tu conductor está llegando" (el más importante del ride-hailing). */
  private async onTripArriving(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripArrivingSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('trip.arriving', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: llegando sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.TRIP_ARRIVING,
        dedupKey: `trip:${p.tripId}:arriving:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { driverName: p.driverName ?? 'Tu conductor' },
          data: { tripId: p.tripId, driverId: p.driverId, screen: 'TripActive' },
        },
      });
    }
  }

  /**
   * trip.arrived → push al pasajero: "tu conductor llegó". Si el evento trae la ventana de espera
   * (waitWindowSeconds) usa el template que la incluye; si no, el simple. NO inventamos la ventana.
   */
  private async onTripArrived(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripArrivedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('trip.arrived', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: llegó sin token push del pasajero → push omitido`);
      return;
    }
    const hasWait = p.waitWindowSeconds !== undefined;
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: hasWait ? TEMPLATE_KEYS.TRIP_ARRIVED_WAIT : TEMPLATE_KEYS.TRIP_ARRIVED,
        dedupKey: `trip:${p.tripId}:arrived:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {
            driverName: p.driverName ?? 'Tu conductor',
            ...(hasWait ? { waitMinutes: Math.round(p.waitWindowSeconds! / 60) } : {}),
          },
          data: { tripId: p.tripId, driverId: p.driverId, screen: 'TripActive' },
        },
      });
    }
  }

  /**
   * trip.cancelled → confirmación HONESTA al pasajero. by=PASSENGER → "cancelaste tu viaje";
   * by=DRIVER (pre-recojo; el post-recojo emite trip.reassigning, no llega acá) → "tu conductor canceló".
   * by=SYSTEM → omitido (no es una acción del pasajero ni del conductor; se cubre con trip.expired/failed).
   */
  private async onTripCancelled(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripCancelledSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    if (p.by === 'SYSTEM') return; // no hay confirmación honesta que dar al pasajero acá
    const template =
      p.by === 'PASSENGER'
        ? TEMPLATE_KEYS.TRIP_CANCELLED_BY_PASSENGER
        : TEMPLATE_KEYS.TRIP_CANCELLED_BY_DRIVER;
    const targets = await this.safeResolveTargets('trip.cancelled', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`trip ${p.tripId}: cancelado (${p.by}) sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template,
        // by entra al dedup: pasajero y conductor pueden cancelar el mismo viaje en ramas distintas.
        dedupKey: `trip:${p.tripId}:cancelled:${p.by}:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { tripId: p.tripId },
        },
      });
    }
  }

  /** payment.captured → push al pasajero: "pago confirmado · S/X.XX" (monto = grossCents). */
  private async onPaymentCaptured(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = paymentCapturedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('payment.captured', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`payment ${p.paymentId}: capturado sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_CAPTURED,
        dedupKey: `payment:${p.paymentId}:captured:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { amount: formatSoles(p.grossCents) },
          data: { tripId: p.tripId, paymentId: p.paymentId },
        },
      });
    }
  }

  /**
   * payment.cash_pending → push al PASAJERO: "confirma tu pago en efectivo de S/X". EFECTIVO (decisión
   * del dueño): el conductor ya confirmó "cobré" al terminar (driverConfirmed); falta SOLO la confirmación
   * del pasajero para capturar. Poison-guard (safeResolveTargets) + dedup por paymentId (una redelivery
   * del mismo cash_pending NO empuja dos veces). El conductor NO recibe push (ya confirmó al terminar).
   */
  private async onPaymentCashPending(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = paymentCashPendingSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('payment.cash_pending', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`payment ${p.paymentId}: efectivo por confirmar sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_CASH_PENDING,
        dedupKey: `payment:${p.paymentId}:cash_pending:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { amount: formatSoles(p.grossCents) },
          // Deep-link: la app abre la pantalla de confirmación de efectivo del viaje.
          data: { tripId: p.tripId, paymentId: p.paymentId, screen: 'CashConfirm' },
        },
      });
    }
  }

  /** payment.refunded → push al pasajero: "te devolvimos S/X.XX" (monto = amountCents reembolsados). */
  private async onPaymentRefunded(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = paymentRefundedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('payment.refunded', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`payment ${p.paymentId}: reembolsado sin token push del pasajero → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId ?? p.tripId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_REFUNDED,
        dedupKey: `payment:${p.paymentId}:refunded:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { amount: formatSoles(p.amountCents) },
          data: { tripId: p.tripId, paymentId: p.paymentId },
        },
      });
    }
  }

  /** payment.affiliation_activated → push al usuario: "Yape quedó vinculado". userId viaja directo. */
  private async onAffiliationActivated(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = affiliationActivatedSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('payment.affiliation_activated', p.userId);
    if (targets.length === 0) {
      this.logger.warn(`afiliación ${p.affiliationId}: activada sin token push del usuario → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.userId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_AFFILIATION_ACTIVATED,
        dedupKey: `affiliation:${p.affiliationId}:activated:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { screen: 'Wallet' },
        },
      });
    }
  }

  /** payment.affiliation_expired → push al usuario: "vuelve a vincular tu Yape". userId viaja directo. */
  private async onAffiliationExpired(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = affiliationExpiredSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    const targets = await this.safeResolveTargets('payment.affiliation_expired', p.userId);
    if (targets.length === 0) {
      this.logger.warn(`afiliación ${p.affiliationId}: expirada sin token push del usuario → push omitido`);
      return;
    }
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.userId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_AFFILIATION_EXPIRED,
        dedupKey: `affiliation:${p.affiliationId}:expired:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: {},
          data: { screen: 'Wallet' },
        },
      });
    }
  }

  /**
   * chat.message_sent → push al DESTINATARIO. NO hay presencia (online/offline) en el sistema → push
   * SIEMPRE, dedup por messageId (at-least-once de Kafka no duplica). Decisión MINIMAL: solo pushamos
   * al PASAJERO cuando escribe el conductor (senderRole=DRIVER) y el evento trae passengerId enriquecido.
   * El caso inverso (avisar al conductor cuando escribe el pasajero) queda como decisión de producto
   * pendiente — NO inventamos presencia ni un destinatario que no viaja en el evento.
   */
  private async onChatMessageSent(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = chatMessageSentSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;
    if (p.senderRole !== 'DRIVER') return; // solo pushamos al pasajero (destinatario = pasajero)
    if (!p.passengerId) {
      this.logger.warn(`chat ${p.messageId}: mensaje del conductor sin passengerId enriquecido → push omitido`);
      return;
    }
    const targets = await this.safeResolveTargets('chat.message_sent', p.passengerId, p.passengerPushToken, p.platform);
    if (targets.length === 0) {
      this.logger.warn(`chat ${p.messageId}: sin token push del pasajero → push omitido`);
      return;
    }
    // Vista previa breve del cuerpo (no exponemos el mensaje completo en la notificación).
    const preview = p.body.length > 60 ? `${p.body.slice(0, 57)}...` : p.body;
    for (const target of targets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.CHAT_MESSAGE,
        // dedup por messageId: una redelivery del mismo mensaje no pushea dos veces.
        dedupKey: `chat:${p.messageId}:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { preview },
          data: { tripId: p.tripId, screen: 'Chat' },
        },
      });
    }
  }
}
