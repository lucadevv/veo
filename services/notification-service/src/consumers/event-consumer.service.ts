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
 *
 * ARQUITECTURA (Lote P · registry declarativo):
 *  - El caso COMÚN (un evento → UN push a UN usuario) vive como FILA en `PUSH_NOTIFICATION_SPECS`
 *    (push-notification.registry.ts). Agregar una notificación push = agregar UNA fila allá; este
 *    servicio registra los `.on()` y deriva el log de suscripciones del registro (cero double-source).
 *  - Lo que hace MÁS que un push queda acá como handler DEDICADO y EXPLÍCITO (`DEDICATED_EVENT_TYPES`):
 *    pánico (fan-out SMS + webhook, SLA p99 < 3s), payment.failed (push + webhook a central) y
 *    penalidad saldada (DOS destinatarios). Forzarlos al registro sería over-engineering del patrón.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + log de suscripción derivado del
 * registro) vive promovido en KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId
 * = UN consumer con TODOS sus eventos en `handlers()` (dedicados + filas del registro juntos).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  isUuid,
  isPermanentDataError,
  EVENT_SCHEMAS,
  type EventEnvelope,
  type EventHandler,
  type EventType,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { NotificationChannel } from '@veo/shared-types';
import { NotificationEngine } from '../engine/notification.engine';
import { NotificationPriority } from '../engine/types';
import { TEMPLATE_KEYS } from '../engine/template.catalog';
import { DeviceTokenRepository, type DeviceTarget } from '../devices/device-token.repository';
import type { Env } from '../config/env.schema';
import {
  PUSH_NOTIFICATION_SPECS,
  runPushSpec,
  formatSoles,
  pushTargetHintSchema,
  type PushSpecContext,
  type PushPlatform,
} from './push-notification.registry';

const MAX_TRUSTED_CONTACTS = 4; // BR-S05

/**
 * Eventos con handler DEDICADO (hacen MÁS que el esqueleto push del registro). Declarados acá,
 * junto al registro de `.on()`, y verificados por contract test (sin solaparse con el registro):
 *  - panic.triggered: fan-out SMS a contactos + webhook firmado a la central (SLA p99 < 3s).
 *  - payment.failed: DOS rieles (push pasajero + webhook central) y la alerta a la central sale
 *    AUNQUE falte el token del pasajero.
 *  - payment.cancellation_penalty_collected: DOS destinatarios (pasajero + conductor condicional).
 */
export const DEDICATED_EVENT_TYPES = [
  'panic.triggered',
  'payment.failed',
  'payment.cancellation_penalty_collected',
] as const satisfies readonly EventType[];

/* ── enrichments de los handlers dedicados (campos FUERA del contrato del registro central) ── */

const contactSchema = z.object({ name: z.string().optional(), phone: z.string().min(1) });

/** panic.triggered: destinatarios reales que el producer enriquece (contactos, link, central). */
const panicEnrichment = z.object({
  contacts: z.array(contactSchema).optional(),
  shareLink: z.string().optional(),
  centralWebhookUrl: z.string().optional(),
});

/** payment.failed: destinatario del push + URL de la central, enriquecidos por el producer. */
const paymentFailedEnrichment = pushTargetHintSchema.extend({
  passengerId: z.string().optional(),
  centralWebhookUrl: z.string().optional(),
});

/** clientId kafkajs de este servicio (también su groupId de consumo). */
const KAFKA_CLIENT_ID = 'notification-service';
const GROUP_ID = 'notification-service';

@Injectable()
export class EventConsumerService extends KafkaConsumerBootstrap {
  private readonly centralWebhookUrl?: string;

  /** Cableado DI del motor del registro: resolución poison-guarded + engine real + logger real. */
  private readonly specContext: PushSpecContext = {
    resolveTargets: (eventType, userId, token, platform) =>
      this.safeResolveTargets(eventType, userId, token, platform),
    enqueue: (input) => this.engine.enqueue(input),
    warn: (message) => this.logger.warn(message),
  };

  constructor(
    private readonly engine: NotificationEngine,
    private readonly devices: DeviceTokenRepository,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
    this.centralWebhookUrl = config.get<string>('CENTRAL_ALERT_WEBHOOK_URL');
  }

  /**
   * Resuelve los destinos de push con POISON-GUARD (única vía de acceso al device-store con un
   * `userId` que viaja en un evento):
   *  - prioriza el token enriquecido del evento; si no llega, busca los devices del usuario.
   *  - isUuid: un `userId` no-UUID iría a una columna `@db.Uuid` → Prisma P2023 → crash-loop.
   *    Lo descartamos en el borde SIN tocar la DB (log + []).
   *  - isPermanentDataError: si el store igual lanza un error PERMANENTE de datos (P2023/P2009…),
   *    lo tratamos como veneno (log + []), NO relanzamos. Lo transitorio (DB caída) SÍ se relanza
   *    (Kafka reintenta el evento). dedup en el engine ⇒ el reintento no duplica el push.
   */
  private async safeResolveTargets(
    eventType: string,
    userId: string | undefined,
    token?: string,
    platform?: PushPlatform,
  ): Promise<DeviceTarget[]> {
    if (token) return [{ token, platform: platform ?? 'android' }];
    if (!userId) return [];
    if (!isUuid(userId)) {
      this.logger.error(`POISON ${eventType}: userId no-UUID "${String(userId)}"; push descartado sin reintento`);
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

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    // Handlers dedicados (multi-canal / multi-destinatario): explícitos, no forzados al registro.
    const record: Record<string, EventHandler> = {
      'panic.triggered': (e) => this.onPanic(e),
      'payment.failed': (e) => this.onPaymentFailed(e),
      'payment.cancellation_penalty_collected': (e) => this.onCancellationPenaltyCollected(e),
    };
    // El caso común: cada fila del registro declarativo pasa por el MISMO motor (runPushSpec).
    for (const spec of Object.values(PUSH_NOTIFICATION_SPECS)) {
      record[spec.eventType] = (e) => runPushSpec(this.specContext, spec, e);
    }
    return record;
  }

  /** El log de suscripciones se DERIVA del mismo record que los .on(): cero double-source. */
  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Consumidores activos (${eventTypes.length}): ${eventTypes.join(', ')}`;
  }

  /** BR-S05: SMS + link a hasta 4 contactos de confianza + alerta (webhook firmado) a la central. */
  private async onPanic(envelope: EventEnvelope<unknown>): Promise<void> {
    const base = EVENT_SCHEMAS['panic.triggered'].safeParse(envelope.payload);
    const extra = panicEnrichment.safeParse(envelope.payload);
    if (!base.success || !extra.success) return;
    const p = { ...base.data, ...extra.data };

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

  /**
   * payment.failed → alerta a la central y al pasajero (BR-P02). DEDICADO: dos rieles, y la alerta
   * a la central sale AUNQUE falte el token del pasajero (no hay early-return tras el warn).
   * dedupKey del push histórico SIN `:push:` (INMUTABLE: cambiarlo duplicaría eventos en vuelo).
   */
  private async onPaymentFailed(envelope: EventEnvelope<unknown>): Promise<void> {
    const base = EVENT_SCHEMAS['payment.failed'].safeParse(envelope.payload);
    const extra = paymentFailedEnrichment.safeParse(envelope.payload);
    if (!base.success || !extra.success) return;
    const p = { ...base.data, ...extra.data };

    const targets = await this.safeResolveTargets('payment.failed', p.passengerId, p.passengerPushToken, p.platform);
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

  /**
   * payment.cancellation_penalty_collected (F2.3) → DOS destinatarios (DEDICADO):
   *  - PASAJERO: "pagaste tu penalidad, ya puedes pedir" (libera el gate en su cabeza).
   *  - CONDUCTOR (si hubo y su compensación > 0): "recibiste S/Y por la espera".
   * Cada push con su propio dedup (penaltyId + rol) → una redelivery no duplica ninguno.
   */
  private async onCancellationPenaltyCollected(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['payment.cancellation_penalty_collected'].safeParse(envelope.payload);
    if (!parsed.success) return;
    const p = parsed.data;

    const passengerTargets = await this.safeResolveTargets(
      'payment.cancellation_penalty_collected',
      p.passengerId,
    );
    if (passengerTargets.length === 0) {
      this.logger.warn(`penalidad ${p.penaltyId}: saldada sin token push del pasajero → push omitido`);
    }
    for (const target of passengerTargets) {
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.PUSH,
        template: TEMPLATE_KEYS.PAYMENT_PENALTY_COLLECTED,
        dedupKey: `penalty:${p.penaltyId}:collected:passenger:push:${target.token}`,
        payload: {
          to: target.token,
          platform: target.platform,
          vars: { amount: formatSoles(p.penaltyCents) },
          data: { tripId: p.tripId, penaltyId: p.penaltyId },
        },
      });
    }

    // Compensación al conductor: solo si esperó (driverId) y le toca algo del split (comp > 0).
    if (p.driverId && p.driverCompensationCents > 0) {
      const driverTargets = await this.safeResolveTargets(
        'payment.cancellation_penalty_collected',
        p.driverId,
      );
      for (const target of driverTargets) {
        await this.engine.enqueue({
          recipientId: p.driverId,
          channel: NotificationChannel.PUSH,
          template: TEMPLATE_KEYS.PAYMENT_PENALTY_DRIVER_COMP,
          dedupKey: `penalty:${p.penaltyId}:collected:driver:push:${target.token}`,
          payload: {
            to: target.token,
            platform: target.platform,
            vars: { amount: formatSoles(p.driverCompensationCents) },
            data: { tripId: p.tripId, penaltyId: p.penaltyId },
          },
        });
      }
    }
  }
}
