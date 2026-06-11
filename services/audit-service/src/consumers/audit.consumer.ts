/**
 * AuditConsumer — consume los eventos auditables del dominio VEO y los registra de forma
 * inmutable (hash chain). Idempotente por envelope.eventId. audit-service principalmente CONSUME.
 *
 * Cobertura actual (eventos definidos en @veo/events · EVENT_SCHEMAS):
 *  - Identidad/KYC: user.registered, driver.verified, biometric.failed
 *  - Derecho al olvido (BR-S06): user.deletion_requested, user.deleted
 *  - Pánico:        panic.triggered, panic.acknowledged
 *  - Pagos:         payment.captured, payment.failed, payout.processed
 *  - Video/Media:   media.recording_started, media.archived
 *  - Viaje (ciclo): trip.assigned/accepted/arriving/arrived/started/completed/cancelled/expired/failed
 *                   + trip.child_code_failed (solo IDs+estado, sin geo → ver nota en registerHandlers)
 *
 * Contratos AÚN no disponibles en @veo/events (ver README · "contratos pendientes"):
 *  - Acceso a video por operador (p.ej. media.accessed) desde media-service.
 *  - Cambios RBAC (p.ej. admin.role_changed / rbac.changed) desde identity-service.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS
 * sus eventos en `handlers()`. Acá solo queda el mapeo de cada evento a su entrada de auditoría.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  topicForEvent,
  EVENT_SCHEMAS,
  type EventType,
  type EventPayload,
  type EventHandler,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { AuditService, type EventAuditMapping } from '../audit/audit.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'audit-service';

@Injectable()
export class AuditConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: config.getOrThrow<string>('KAFKA_GROUP_ID'),
      fromBeginning: config.getOrThrow<boolean>('KAFKA_FROM_BEGINNING'),
    });
  }

  override async onModuleInit(): Promise<void> {
    try {
      await super.onModuleInit();
    } catch (err) {
      this.logger.error({ err }, 'No se pudo iniciar el consumidor de Kafka');
      throw err;
    }
  }

  protected override subscriptionLog(): string {
    return 'Consumidor de eventos auditables iniciado';
  }

  /** TODOS los eventos del group, en un solo record (regla de oro de @veo/events/nest). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      // Identidad / KYC
      'user.registered': this.audited('user.registered', (p) => ({
        actorId: p.userId,
        resourceType: 'user',
        resourceId: p.userId,
      })),
      'driver.verified': this.audited('driver.verified', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      'biometric.failed': this.audited('biometric.failed', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),

      // Derecho al olvido (BR-S06 · Ley 29733): traza inmutable de cada etapa del borrado.
      // user.deletion_requested = solicitud (inicia la gracia); user.deleted = borrado efectivo (sweep).
      'user.deletion_requested': this.audited('user.deletion_requested', (p) => ({
        actorId: p.userId,
        resourceType: 'user',
        resourceId: p.userId,
      })),
      'user.deleted': this.audited('user.deleted', (p) => ({
        actorId: p.userId,
        resourceType: 'user',
        resourceId: p.userId,
      })),

      // Pánico
      'panic.triggered': this.audited('panic.triggered', (p) => ({
        actorId: p.passengerId,
        resourceType: 'panic',
        resourceId: p.panicId,
      })),
      'panic.acknowledged': this.audited('panic.acknowledged', (p) => ({
        actorId: p.operatorId,
        resourceType: 'panic',
        resourceId: p.panicId,
      })),

      // Pagos
      'payment.captured': this.audited('payment.captured', (p) => ({
        actorId: 'system',
        resourceType: 'payment',
        resourceId: p.paymentId,
      })),
      'payment.failed': this.audited('payment.failed', (p) => ({
        actorId: 'system',
        resourceType: 'payment',
        resourceId: p.paymentId,
      })),
      'payout.processed': this.audited('payout.processed', (p) => ({
        actorId: p.driverId,
        resourceType: 'payout',
        resourceId: p.payoutId,
      })),

      // Video / Media (ciclo de vida de la grabación · BR-S01)
      'media.recording_started': this.audited('media.recording_started', (p) => ({
        actorId: 'system',
        resourceType: 'media',
        resourceId: p.tripId,
      })),
      'media.archived': this.audited('media.archived', (p) => ({
        actorId: 'system',
        resourceType: 'media',
        resourceId: p.tripId,
      })),

      // Viaje (ciclo de vida · trazabilidad forense, movilidad segura / Ley 29733): la cadena de custodia
      // debe poder reconstruir QUÉ pasó en un viaje (quién lo aceptó/inició/completó/canceló y cuándo), no
      // solo el pánico. Se auditan las TRANSICIONES de estado (resourceId=tripId, actorId=conductor en las
      // que él ejecuta / `system` en las del watchdog / la parte que canceló en cancelled). Se EXCLUYEN a
      // propósito trip.requested / trip.bid_posted / trip.reassigning: llevan geo (origin/destination) y el
      // audit persiste el payload en WORM inmutable — la traza forense del viaje no necesita la ubicación.
      'trip.assigned': this.audited('trip.assigned', (p) => ({ actorId: p.driverId, resourceType: 'trip', resourceId: p.tripId })),
      'trip.accepted': this.audited('trip.accepted', (p) => ({ actorId: p.driverId, resourceType: 'trip', resourceId: p.tripId })),
      'trip.arriving': this.audited('trip.arriving', (p) => ({ actorId: p.driverId, resourceType: 'trip', resourceId: p.tripId })),
      'trip.arrived': this.audited('trip.arrived', (p) => ({ actorId: p.driverId, resourceType: 'trip', resourceId: p.tripId })),
      'trip.started': this.audited('trip.started', (p) => ({ actorId: p.driverId, resourceType: 'trip', resourceId: p.tripId })),
      'trip.completed': this.audited('trip.completed', (p) => ({
        actorId: p.driverId ?? 'system',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.cancelled': this.audited('trip.cancelled', (p) => ({
        actorId:
          p.by === 'DRIVER'
            ? (p.driverId ?? 'driver')
            : p.by === 'PASSENGER'
              ? (p.passengerId ?? 'passenger')
              : 'system',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.expired': this.audited('trip.expired', (p) => ({ actorId: 'system', resourceType: 'trip', resourceId: p.tripId })),
      'trip.failed': this.audited('trip.failed', (p) => ({ actorId: 'system', resourceType: 'trip', resourceId: p.tripId })),
      // Seguridad: un código de modo niño fallido es un intento sospechoso → cadena de custodia (BR-T07).
      'trip.child_code_failed': this.audited('trip.child_code_failed', (p) => ({
        actorId: p.driverId ?? 'driver',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
    };
  }

  /** Construye el handler tipado de un eventType: mapea su payload a una entrada de auditoría. */
  private audited<T extends EventType>(
    type: T,
    map: (payload: EventPayload<T>) => EventAuditMapping,
  ): EventHandler {
    const schema = EVENT_SCHEMAS[type];
    return async (envelope) => {
      const payload = schema.parse(envelope.payload) as EventPayload<T>;
      try {
        await this.audit.recordFromEvent(envelope, topicForEvent(type), map(payload));
      } catch (err) {
        this.logger.error({ err, eventType: type, eventId: envelope.eventId }, 'fallo al auditar evento');
        throw err;
      }
    };
  }
}
