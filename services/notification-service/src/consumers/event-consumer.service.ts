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
import { Inject, Injectable } from '@nestjs/common';
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
import { SHARE_CONTACTS_RESOLVER, type TrustedContactsResolver } from '../ports/share/share-contacts.port';
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
  'panic.fanout_requested',
  'payment.failed',
  'payment.cancellation_penalty_collected',
] as const satisfies readonly EventType[];

/* ── enrichments de los handlers dedicados (campos FUERA del contrato del registro central) ── */

/** panic.triggered: la URL de la central (la única pieza que panic.triggered necesita enriquecer). */
const panicEnrichment = z.object({
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
    @Inject(SHARE_CONTACTS_RESOLVER) private readonly shareContacts: TrustedContactsResolver,
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
      'panic.fanout_requested': (e) => this.onPanicFanout(e),
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

  /**
   * panic.triggered → SOLO la alerta (webhook firmado) a la central de monitoreo.
   *
   * El fan-out de SMS a contactos YA NO vive acá: lo dispara `onPanicFanout` (evento
   * panic.fanout_requested que emite share-service tras crear el enlace, con los IDs de contacto).
   * Separar evita el doble envío y rompe la dependencia de un enrichment de contactos que el
   * producer de panic.triggered nunca llenaba (causa del gap "contacts vacío → SMS omitidos").
   */
  private async onPanic(envelope: EventEnvelope<unknown>): Promise<void> {
    const base = EVENT_SCHEMAS['panic.triggered'].safeParse(envelope.payload);
    const extra = panicEnrichment.safeParse(envelope.payload);
    if (!base.success || !extra.success) return;
    const p = { ...base.data, ...extra.data };

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
   * panic.fanout_requested (BR-S05, fix de durabilidad) → fan-out DURABLE de SMS a los contactos de
   * confianza. share-service ya creó el enlace y delegó acá con SOLO los IDs de contacto + el deep-link
   * (CERO PII en Kafka, §0.7). Resolvemos teléfonos+nombres por gRPC GetTrustedContacts y encolamos un
   * SMS por contacto en el engine durable (retry/backoff/SMPP) — un fallo del proveedor NO se pierde.
   *
   * Idempotencia: dedupKey `panic:{panicId}:sms:{contactId}` (contactId, NO el teléfono → ni PII en la
   * clave ni en logs). Una redelivery del evento NO duplica el SMS (dedup del engine).
   *
   * Degradación honesta: si el gRPC a share falla (transitorio), RELANZAMOS para que Kafka reintente
   * el evento; el dedup del engine evita duplicar lo ya encolado. El SMS no se pierde por un blip.
   */
  private async onPanicFanout(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = EVENT_SCHEMAS['panic.fanout_requested'].safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn('panic.fanout_requested: payload inválido (descarto sin reintento)');
      return;
    }
    const p = parsed.data;

    if (p.contactIds.length === 0) {
      this.logger.warn(`panic ${p.panicId}: fan-out sin contactIds → nada que notificar`);
      return;
    }

    // PII resuelta SÍNCRONAMENTE por gRPC (jamás viaja por Kafka). Un fallo acá es transitorio → relanza.
    const resolved = await this.shareContacts.resolveByPassenger(p.passengerId);
    const byId = new Map(resolved.map((c) => [c.id, c]));

    const targets = p.contactIds.slice(0, MAX_TRUSTED_CONTACTS);
    let enqueued = 0;
    for (const contactId of targets) {
      const contact = byId.get(contactId);
      if (!contact) {
        // El contacto fue borrado/desverificado entre el trigger y el fan-out: gap honesto, no rompe el resto.
        this.logger.warn(`panic ${p.panicId}: contacto ${contactId} no resuelto por share → SMS omitido`);
        continue;
      }
      await this.engine.enqueue({
        recipientId: p.passengerId,
        channel: NotificationChannel.SMS,
        template: TEMPLATE_KEYS.PANIC_CONTACT_ALERT,
        // SAFETY: el pánico drena ANTES que cualquier transaccional/broadcast (SLA fan-out p99 < 3s).
        priority: NotificationPriority.Critical,
        // dedupKey por contactId (NO por teléfono): idempotente y sin PII en la clave.
        dedupKey: `panic:${p.panicId}:sms:${contactId}`,
        payload: {
          to: contact.phone,
          vars: {
            name: contact.name,
            shareLink: p.shareLink,
            lat: p.geo.lat,
            lon: p.geo.lon,
          },
        },
      });
      enqueued += 1;
    }
    this.logger.log(`panic ${p.panicId}: fan-out encoló ${enqueued}/${targets.length} SMS (durable)`);
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
