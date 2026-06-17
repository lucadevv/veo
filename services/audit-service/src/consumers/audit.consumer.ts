/**
 * AuditConsumer — consume los eventos auditables del dominio VEO y los registra de forma
 * inmutable (hash chain). Idempotente por envelope.eventId. audit-service principalmente CONSUME.
 *
 * Cobertura actual (eventos definidos en @veo/events · EVENT_SCHEMAS):
 *  - Identidad/KYC: user.registered, user.email_verified, user.kyc_verified, driver.verified, biometric.failed
 *  - Derecho al olvido (BR-S06): user.deletion_requested, user.deleted, trip.pii_erased
 *  - Pánico:        panic.triggered, panic.acknowledged, panic.resolved
 *  - Pagos:         payment.captured, payment.failed, payout.processed
 *  - Recompensas:   user.referred (vínculo creado), referral.rewarded, promo.redeemed, incentive.completed (movimientos de crédito · Ley 29733)
 *  - Video/Media:   media.recording_started, media.archived, media.access_granted
 *  - Viaje (ciclo): trip.assigned/accepted/arriving/arrived/started/completed/cancelled/expired/failed
 *                   + trip.child_code_failed (solo IDs+estado, sin geo → ver nota en registerHandlers)
 *
 * Contratos pendientes en @veo/events (ver README · "contratos pendientes"):
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
      // Confirmación de titularidad del correo (ADR-012 · Ley 29733): traza inmutable de QUIÉN verificó su
      // correo y cuándo. El payload trae al sujeto (userId) — no porta verificador → actor=recurso=userId
      // (el titular del dato verificado), mismo patrón que user.registered/user.kyc_verified. El email viaja
      // en el payload del evento (necesario para el consentimiento verificado), no se duplica en el mapping.
      'user.email_verified': this.audited('user.email_verified', (p) => ({
        actorId: p.userId,
        resourceType: 'user',
        resourceId: p.userId,
      })),
      // KYC aprobado (BR-S05): traza de quién quedó verificado y cuándo. El payload solo trae al sujeto
      // verificado (userId) — no porta verificador → actor=recurso=userId (el dueño del dato verificado).
      'user.kyc_verified': this.audited('user.kyc_verified', (p) => ({
        actorId: p.userId,
        resourceType: 'user',
        resourceId: p.userId,
      })),
      'driver.verified': this.audited('driver.verified', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Rechazo de antecedentes (BR-S03): traza inmutable de la decisión. El payload trae al conductor
      // (driverId); el operador que decidió se traza por el comando admin (audit.record en admin-bff).
      // Acá actor=recurso=driverId (el sujeto de la decisión proyectada por el evento de dominio).
      'driver.rejected': this.audited('driver.rejected', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Suspensión MANUAL por un operador (BR-S03): traza inmutable de la decisión de SAFETY. El operador
      // que decidió se traza por el comando admin (audit.record en admin-bff); acá actor=recurso=driverId
      // (el sujeto de la decisión proyectada por el evento de dominio, igual que driver.rejected).
      'driver.suspended': this.audited('driver.suspended', (p) => ({
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
      // PII de un viaje borrada (BR-S06 · derecho al olvido): traza inmutable de QUÉ viaje se anonimizó.
      // El payload trae el viaje (tripId) y al pasajero dueño del dato (passengerId) — sin sweeper explícito
      // → actorId=passengerId (el titular cuyo derecho se ejecutó), recurso=trip/tripId.
      'trip.pii_erased': this.audited('trip.pii_erased', (p) => ({
        actorId: p.passengerId,
        resourceType: 'trip',
        resourceId: p.tripId,
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
      // Cierre de la emergencia: traza de QUIÉN resolvió el incidente (resolvedBy, calca el operatorId de
      // acknowledged) y sobre QUÉ panic. Cierra la cadena triggered→acknowledged→resolved en el WORM.
      'panic.resolved': this.audited('panic.resolved', (p) => ({
        actorId: p.resolvedBy,
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

      // Recompensas / créditos (Ola 2A/2C · Ley 29733): los movimientos de dinero —crédito al referidor,
      // bono al conductor, descuento de promo— quedan en el WORM inmutable para reconstruir QUIÉN recibió
      // QUÉ crédito y cuándo. actorId = el beneficiario del movimiento; recurso = la entidad de recompensa.
      // Vínculo de referido CREADO (Ola 2A · Ley 29733): traza inmutable de QUIÉN refirió a QUIÉN y con qué
      // código, antes de que se otorgue la recompensa (referral.rewarded llega luego, al 1er viaje). Permite
      // reconstruir el origen de cada cuenta referida (antifraude/compliance). actorId=referidor (quien
      // ejecuta la acción), recurso=referral/referido (la entidad creada). El código viaja en el payload.
      'user.referred': this.audited('user.referred', (p) => ({
        actorId: p.referrerUserId,
        resourceType: 'referral',
        resourceId: p.referredUserId,
      })),
      'referral.rewarded': this.audited('referral.rewarded', (p) => ({
        actorId: p.referrerUserId,
        resourceType: 'referral',
        resourceId: p.referredUserId,
      })),
      'promo.redeemed': this.audited('promo.redeemed', (p) => ({
        actorId: p.userId,
        resourceType: 'promotion',
        resourceId: p.promotionId,
      })),
      'incentive.completed': this.audited('incentive.completed', (p) => ({
        actorId: p.driverId,
        resourceType: 'incentive',
        resourceId: p.incentiveId,
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
      // Doble auth para acceso a video (Ley 29733 · regla no negociable #1): traza QUIÉN vio QUÉ video.
      // actorId=operatorId (quien accedió); recurso = segmento concreto si lo hay, fallback al viaje
      // (segmentId es optional en el contrato → resourceId cae a tripId).
      'media.access_granted': this.audited('media.access_granted', (p) => ({
        actorId: p.operatorId,
        resourceType: 'media',
        resourceId: p.segmentId ?? p.tripId,
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
