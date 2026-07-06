/**
 * AuditConsumer — consume los eventos auditables del dominio VEO y los registra de forma
 * inmutable (hash chain). Idempotente por envelope.eventId. audit-service principalmente CONSUME.
 *
 * Cobertura actual (eventos definidos en @veo/events · EVENT_SCHEMAS):
 *  - Identidad/KYC: user.registered, user.email_verified, user.kyc_verified, driver.verified, biometric.failed
 *  - Derecho al olvido (BR-S06): user.deletion_requested, user.deleted, trip.pii_erased
 *  - Pánico:        panic.triggered, panic.acknowledged, panic.resolved
 *  - Pagos:         payment.captured, payment.failed, payment.refunded (plata que vuelve al pasajero),
 *                   payout.processing/processed/failed (ciclo de desembolso al conductor · ADR-015 §4.1/§6)
 *  - Recompensas:   user.referred (vínculo creado), referral.rewarded, promo.redeemed, incentive.completed (movimientos de crédito · Ley 29733)
 *  - Video/Media:   media.recording_started, media.archived, media.access_granted,
 *                   media.access_viewed (reproducción efectiva · BR-S02), media.access_rejected (denegación · cadena de custodia)
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
      // Enrol biométrico del alta (KYC selfie + liveness PASIVO): traza inmutable de que SE ejecutó una
      // verificación biométrica de registro (Ley 29733). El veredicto de vida (livenessChecked/score) viaja
      // en el envelope. actor=recurso=driverId (sujeto del enrol proyectado por el evento de dominio).
      'biometric.enrolled': this.audited('biometric.enrolled', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Intento de SUPLANTACIÓN en el enrol (el PAD rechazó la captura: foto/pantalla/replay): traza forense
      // inmutable del ataque de presentación. El motivo + score viajan en el envelope.
      'biometric.enroll_rejected': this.audited('biometric.enroll_rejected', (p) => ({
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
      // Reembolso EFECTIVO (BR-P06 · Ley 29733 · regla no negociable #1): la plata que VUELVE al pasajero es
      // un movimiento de dinero y debe quedar en el WORM inmutable igual que captured/failed (cierra el gap de
      // "movimiento de plata sin audit"). `approvedBy` = quién aprobó la devolución (un operador en el refund
      // admin, o 'system' en el system-initiated por booking.cancelled) → es el ACTOR del movimiento; recurso =
      // el Payment reembolsado. amountCents/tripId/passengerId viajan en el payload del evento persistido.
      'payment.refunded': this.audited('payment.refunded', (p) => ({
        actorId: p.approvedBy,
        resourceType: 'payment',
        resourceId: p.paymentId,
      })),
      // Desembolso al conductor (ADR-015 §4.1/§6 · movimiento de plata al WORM inmutable · Ley 29733): el ciclo
      // PROCESSING → PROCESSED/FAILED queda trazado entero. `processing` = el OPERADOR disparó el desembolso (acto
      // humano); `failed` = el riel lo rechazó/expiró (la plata NO salió). Mismo mapeo que `processed` —
      // actorId=driverId (el beneficiario del movimiento), recurso=payout/payoutId. El payload solo trae IDs +
      // monto + período (CERO PII, `.strict()` fail-closed en el contrato), igual que processed.
      'payout.processing': this.audited('payout.processing', (p) => ({
        actorId: p.driverId,
        resourceType: 'payout',
        resourceId: p.payoutId,
      })),
      'payout.processed': this.audited('payout.processed', (p) => ({
        actorId: p.driverId,
        resourceType: 'payout',
        resourceId: p.payoutId,
      })),
      'payout.failed': this.audited('payout.failed', (p) => ({
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
      // Reproducción EFECTIVA de un video aprobado (BR-S02 · Ley 29733): cada visualización firma URL +
      // watermark fresco y se audita aparte del grant → traza QUIÉN reprodujo QUÉ segmento, no solo quién
      // obtuvo el permiso. actorId=viewedBy (quien reprodujo); segmentId es REQUERIDO en este contrato.
      'media.access_viewed': this.audited('media.access_viewed', (p) => ({
        actorId: p.viewedBy,
        resourceType: 'media',
        resourceId: p.segmentId,
      })),
      // DENEGACIÓN del supervisor (BR-S02 · cadena de custodia): el rechazo cierra la solicitud sin otorgar
      // acceso y debe quedar en el WORM tanto como el grant. actorId=rejectedBy (quien denegó); recurso =
      // segmento concreto si lo hay, fallback al viaje (segmentId es optional en el contrato).
      'media.access_rejected': this.audited('media.access_rejected', (p) => ({
        actorId: p.rejectedBy,
        resourceType: 'media',
        resourceId: p.segmentId ?? p.tripId,
      })),
      // Render (burn-in Lote 3) de un acceso YA APROBADO: el quemado server-side del watermark de la copia
      // derivada TERMINÓ (completed) o FALLÓ de forma reintentable/terminal (failed). Sin estos handlers, una
      // falla PERMANENTE de render de un video aprobado NO dejaría rastro inmutable (BR-S02 incompleto). Es
      // trabajo del SISTEMA (worker), sin operador humano → actor='system' (mismo patrón que recording_started/
      // archived). resource=media: el segmento concreto rendido (completed lo trae) o el viaje (failed no porta
      // segmentId). El payload es CERO PII (IDs/categoría técnica de error/timestamp); la proyección lo allowlista.
      'media.render_completed': this.audited('media.render_completed', (p) => ({
        actorId: 'system',
        resourceType: 'media',
        resourceId: p.segmentId,
      })),
      'media.render_failed': this.audited('media.render_failed', (p) => ({
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
      'trip.assigned': this.audited('trip.assigned', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.accepted': this.audited('trip.accepted', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.arriving': this.audited('trip.arriving', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.arrived': this.audited('trip.arrived', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.started': this.audited('trip.started', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
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
      'trip.expired': this.audited('trip.expired', (p) => ({
        actorId: 'system',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.failed': this.audited('trip.failed', (p) => ({
        actorId: 'system',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      // Seguridad: un código de modo niño fallido es un intento sospechoso → cadena de custodia (BR-T07).
      'trip.child_code_failed': this.audited('trip.child_code_failed', (p) => ({
        actorId: p.driverId ?? 'driver',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),

      // ─────────────────────────────────────────────────────────────────────────────────────────────
      // TRAZABILIDAD TOTAL (VEO_SPEC_ADMIN:106 "auditar todo todo" · FOUNDATION §0.4/§6 · Ley 29733).
      // Se auditan TODOS los eventos MUTANTES de dominio. Mapeo: actorId = quién ejecutó la acción (id del
      // actor humano si el payload lo trae; 'system' si es automático: cron/regla/watchdog); resourceType =
      // tipo de entidad afectada (constante del recurso, no string mágico de estado); resourceId = id de la
      // entidad. Las EXCLUSIONES (firehose / contenido-en-payload-sin-valor-forense) están documentadas en el
      // bloque AUDIT_EXCLUSIONS al final de este método con su razón.
      // ─────────────────────────────────────────────────────────────────────────────────────────────

      // ── A · MOVIMIENTOS DE DINERO (Ley 29733 · regla no negociable #1: toda plata al WORM inmutable) ──
      // Propina (BR-P04): 100% al conductor, fuera de comisión. La inicia el pasajero pero el payload no porta
      // su id (solo driverId opcional) → actor='system' (riel de cobro), recurso=payment/paymentId. Mismo
      // patrón que payment.captured (el movimiento lo ejecuta el sistema de pagos, no un actor humano trazable).
      'payment.tip_added': this.audited('payment.tip_added', (p) => ({
        actorId: 'system',
        resourceType: 'payment',
        resourceId: p.paymentId,
      })),
      // Efectivo bilateral (BR-P03): se creó un Payment CASH PENDING esperando confirmación del pasajero. El
      // movimiento lo materializa payment-service desde trip.completed → actor='system', recurso=payment.
      'payment.cash_pending': this.audited('payment.cash_pending', (p) => ({
        actorId: 'system',
        resourceType: 'payment',
        resourceId: p.paymentId,
      })),
      // Penalidad de cancelación REGISTRADA (F2): obligación de plata del pasajero que canceló. actor=passengerId
      // (el deudor que originó la penalidad), recurso=penalty/penaltyId. Cierra la traza del split conductor/plataforma.
      'payment.cancellation_penalty_recorded': this.audited(
        'payment.cancellation_penalty_recorded',
        (p) => ({
          actorId: p.passengerId,
          resourceType: 'penalty',
          resourceId: p.penaltyId,
        }),
      ),
      // Penalidad SALDADA (F2.3): el pasajero la pagó por el rail. actor=passengerId (quien saldó), recurso=penalty.
      'payment.cancellation_penalty_collected': this.audited(
        'payment.cancellation_penalty_collected',
        (p) => ({
          actorId: p.passengerId,
          resourceType: 'penalty',
          resourceId: p.penaltyId,
        }),
      ),
      // Afiliación de wallet (Yape On File) ACTIVADA: el usuario afilió su billetera (acto del titular).
      // actor=userId (quien afilió), recurso=affiliation/affiliationId. phoneMasked viaja enmascarado, nunca completo.
      'payment.affiliation_activated': this.audited('payment.affiliation_activated', (p) => ({
        actorId: p.userId,
        resourceType: 'affiliation',
        resourceId: p.affiliationId,
      })),
      // Afiliación EXPIRADA (vencimiento automático del mandato): no hay acto humano → actor='system',
      // recurso=affiliation/affiliationId (el titular se traza por affiliation_activated, este es el cierre auto).
      'payment.affiliation_expired': this.audited('payment.affiliation_expired', (p) => ({
        actorId: 'system',
        resourceType: 'affiliation',
        resourceId: p.affiliationId,
      })),

      // ── B · ACCESO / SEGURIDAD / DECISIONES ADMINISTRATIVAS (cadena de custodia) ──
      // Cambio de RBAC (contrato pendiente del README ahora cubierto): traza inmutable de QUIÉN cambió los roles
      // de QUIÉN. actor=changedBy (el operador que ejecutó el cambio), recurso=admin/adminUserId (la cuenta afectada).
      'admin.role_changed': this.audited('admin.role_changed', (p) => ({
        actorId: p.changedBy,
        resourceType: 'admin',
        resourceId: p.adminUserId,
      })),
      // AUTO-suspensión por exceso de cancelaciones (regla automática de dispatch, ventana rolling 24h): no hay
      // operador → actor='system', recurso=driver/driverId. Traza la decisión automática que suspende al conductor.
      'driver.excessive_cancellations': this.audited('driver.excessive_cancellations', (p) => ({
        actorId: 'system',
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Flag de rating del CONDUCTOR (regla automática de rating-service por avg bajo): actor='system', recurso=driver.
      'driver.flagged': this.audited('driver.flagged', (p) => ({
        actorId: 'system',
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Flag de rating del PASAJERO (BR-I05, regla automática): actor='system', recurso=passenger/passengerId.
      'passenger.flagged': this.audited('passenger.flagged', (p) => ({
        actorId: 'system',
        resourceType: 'passenger',
        resourceId: p.passengerId,
      })),
      // RE-activación del conductor por el OPERADOR (inversa de driver.suspended): el operador se traza por el
      // comando admin (audit.record en admin-bff); acá actor=recurso=driverId (sujeto de la decisión proyectada
      // por el evento de dominio, MISMO patrón que driver.suspended/rejected — el payload no porta operador).
      'driver.reactivated': this.audited('driver.reactivated', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Suspensión AUTOMÁTICA del conductor por documento/ITV crítico vencido (fleet-service): no hay operador →
      // actor='system'. El sujeto llega por XOR driverId(perfil) | userId(User.id, vía ITV) → recurso = el que venga.
      'fleet.driver_suspended': this.audited('fleet.driver_suspended', (p) => ({
        actorId: 'system',
        resourceType: 'driver',
        resourceId: p.driverId ?? p.userId ?? 'unknown',
      })),
      // AUTO-reactivación del conductor por compliance (fleet-service, el conductor regularizó): actor='system'
      // (sin operador), recurso = driverId|userId (mismo XOR que la suspensión).
      'fleet.driver_reactivated': this.audited('fleet.driver_reactivated', (p) => ({
        actorId: 'system',
        resourceType: 'driver',
        resourceId: p.driverId ?? p.userId ?? 'unknown',
      })),
      // Suspensión de un VEHÍCULO (fleet-service, regla automática por documento): actor='system', recurso=vehicle.
      'fleet.vehicle_suspended': this.audited('fleet.vehicle_suspended', (p) => ({
        actorId: 'system',
        resourceType: 'vehicle',
        resourceId: p.vehicleId,
      })),

      // ── C · CICLO DE VIDA (entidades mutantes: alta, flota, dispatch, pricing, rating) ──
      // Alta del conductor MATERIALIZADA (crea el agregado Driver, queda PENDING): actor=recurso=driverId.
      'driver.registered': this.audited('driver.registered', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // El conductor RECHAZADO corrigió y REENVIÓ a revisión (BR-I01): acto del conductor → actor=recurso=driverId.
      'driver.resubmitted': this.audited('driver.resubmitted', (p) => ({
        actorId: p.driverId,
        resourceType: 'driver',
        resourceId: p.driverId,
      })),
      // Documento de flota VENCIDO (fleet-service, watchdog temporal): traza inmutable del vencimiento crítico.
      // actor='system' (vencimiento automático), recurso=driver|vehicle según ownerType, id=ownerId.
      'fleet.document_expired': this.audited('fleet.document_expired', (p) => ({
        actorId: 'system',
        resourceType: p.ownerType === 'VEHICLE' ? 'vehicle' : 'driver',
        resourceId: p.ownerId,
      })),
      // Documento del conductor RECHAZADO por el operador (compliance, Ley 29733): traza inmutable de la decisión.
      // Solo se emite para docs DRIVER-scoped → recurso=driver, id=ownerId (Driver.id de perfil). El operador que
      // decidió se traza por el comando admin (audit.record en admin-bff); acá actor=recurso=ownerId (el sujeto de
      // la decisión proyectada por el evento de dominio, igual que driver.rejected). El reason NO viaja (data-min §0.7).
      'fleet.document_rejected': this.audited('fleet.document_rejected', (p) => ({
        actorId: p.ownerId,
        resourceType: 'driver',
        resourceId: p.ownerId,
      })),
      // Vehículo REGISTRADO en la flota (alta del agregado Vehicle): el conductor lo registró → actor=driverId,
      // recurso=vehicle/vehicleId.
      'fleet.vehicle_registered': this.audited('fleet.vehicle_registered', (p) => ({
        actorId: p.driverId,
        resourceType: 'vehicle',
        resourceId: p.vehicleId,
      })),
      // Modelo de vehículo REVISADO por el operador (APPROVED/REJECTED): el operador se traza por el comando admin;
      // el payload trae al solicitante (requestedBy = userId del conductor) → actor=requestedBy, recurso=vehicle_model/modelId.
      'fleet.vehicle_model_reviewed': this.audited('fleet.vehicle_model_reviewed', (p) => ({
        actorId: p.requestedBy,
        resourceType: 'vehicle_model',
        resourceId: p.modelId,
      })),
      // Dispatch · match encontrado (FIXED): el conductor fue emparejado a un viaje. actor=driverId, recurso=dispatch,
      // id=tripId (el dispatch es efímero en Redis; el tripId es el ancla forense estable). SIN geo en este evento.
      'dispatch.match_found': this.audited('dispatch.match_found', (p) => ({
        actorId: p.driverId,
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Dispatch · oferta de un conductor a una puja (ACCEPT_PRICE/COUNTER): actor=driverId, recurso=dispatch/tripId. Sin geo.
      'dispatch.offer_made': this.audited('dispatch.offer_made', (p) => ({
        actorId: p.driverId,
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Dispatch · el pasajero ELIGIÓ la oferta de este conductor (deriva el match): actor=driverId, recurso=dispatch/tripId.
      'dispatch.offer_accepted': this.audited('dispatch.offer_accepted', (p) => ({
        actorId: p.driverId,
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Dispatch · sin conductor (cierre del board → trip EXPIRED): decisión automática → actor='system', recurso=dispatch/tripId.
      'dispatch.no_offers': this.audited('dispatch.no_offers', (p) => ({
        actorId: 'system',
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Dispatch · el PASAJERO canceló la puja (cierre del board). El payload no porta passengerId (reason literal) →
      // actor='passenger' (la parte que canceló, mismo estilo de fallback que trip.cancelled), recurso=dispatch/tripId.
      'dispatch.bid_cancelled': this.audited('dispatch.bid_cancelled', (p) => ({
        actorId: 'passenger',
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Dispatch · una oferta individual dejó de ser válida (stale/taken): el conductor quedó inelegible → actor=driverId,
      // recurso=dispatch/tripId.
      'dispatch.offer_withdrawn': this.audited('dispatch.offer_withdrawn', (p) => ({
        actorId: p.driverId,
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),
      // Pricing · el ADMIN editó el schedule de modo PUJA↔FIJO (snapshot completo · ADR-011). El operador se traza por
      // el comando admin-bff; el payload es un snapshot de config SIN actor ni id de entidad → actor='system'
      // (config aplicada), recurso=pricing, id='mode_schedule' (la pieza de config afectada; `version` viaja en el payload).
      'pricing.mode_schedule_updated': this.audited('pricing.mode_schedule_updated', () => ({
        actorId: 'system',
        resourceType: 'pricing',
        resourceId: 'mode_schedule',
      })),
      // Pricing · el ADMIN reemplazó el piso de la PUJA (snapshot · ADR-010 §9.3). Mismo razonamiento que mode_schedule:
      // actor='system' (config aplicada), recurso=pricing, id='bid_floor'.
      'pricing.bid_floor_updated': this.audited('pricing.bid_floor_updated', () => ({
        actorId: 'system',
        resourceType: 'pricing',
        resourceId: 'bid_floor',
      })),
      // Pricing · el ADMIN reemplazó la tarifa BASE (base/km/min · F2.4). Es DINERO al WORM (regla no negociable #1);
      // mismo patrón de config-admin que mode_schedule/bid_floor: el operador se traza por el comando admin-bff, el
      // payload es un snapshot SIN actor ni id de entidad → actor='system' (config aplicada), recurso=pricing, id='base_fare'.
      'pricing.base_fare_updated': this.audited('pricing.base_fare_updated', () => ({
        actorId: 'system',
        resourceType: 'pricing',
        resourceId: 'base_fare',
      })),
      // Payment · el ADMIN reemplazó las tasas de COMISIÓN (on-demand/carpooling bps · F2.7, con step-up MFA). Define
      // el split de plata plataforma↔conductor → DINERO al WORM. Config-admin: actor='system', recurso=pricing
      // (agrupa toda la config tarifaria), id='commission'. El operador que la cambió se traza por el comando admin-bff.
      'payment.commission_updated': this.audited('payment.commission_updated', () => ({
        actorId: 'system',
        resourceType: 'pricing',
        resourceId: 'commission',
      })),
      // Rating CREADO (BR-D01): una reseña entró al sistema. El payload no porta al autor (solo ratingId/tripId/driverId/stars)
      // → actor='system' (riel de rating; el autor es anónimo por diseño de la reseña), recurso=rating/ratingId.
      'rating.created': this.audited('rating.created', (p) => ({
        actorId: 'system',
        resourceType: 'rating',
        resourceId: p.ratingId,
      })),

      // ── C/booking · CICLO DE VIDA DEL MARKETPLACE DE CARPOOLING (ADR-014) ──
      // Oferta PUBLICADA (PublishedTrip BORRADOR→PUBLICADO): el conductor publicó → actor=driverId, recurso=published_trip.
      'booking.published': this.audited('booking.published', (p) => ({
        actorId: p.driverId,
        resourceType: 'published_trip',
        resourceId: p.publishedTripId,
      })),
      // Booking SOLICITADO (REVISION → PENDIENTE_APROBACION): el pasajero reservó → actor=passengerId, recurso=booking/bookingId.
      'booking.requested': this.audited('booking.requested', (p) => ({
        actorId: p.passengerId,
        resourceType: 'booking',
        resourceId: p.bookingId,
      })),
      // Booking APROBADO: origen INSTANT (nace aprobado, sin actor humano) o APROBACION_CONDUCTOR (el conductor aprobó).
      // actor = driverId si lo aprobó el conductor; 'system' si nació aprobado por INSTANT_BOOKING. recurso=booking/bookingId.
      'booking.approved': this.audited('booking.approved', (p) => ({
        actorId: p.origen === 'APROBACION_CONDUCTOR' ? p.driverId : 'system',
        resourceType: 'booking',
        resourceId: p.bookingId,
      })),
      // Oferta EDITADA (F1a, patch del PublishedTrip): el conductor editó → actor=driverId, recurso=published_trip.
      'booking.updated': this.audited('booking.updated', (p) => ({
        actorId: p.driverId,
        resourceType: 'published_trip',
        resourceId: p.publishedTripId,
      })),
      // Booking CONFIRMADO (cobro capturó + seat-lock): lo materializa el sistema desde payment.captured → actor='system',
      // recurso=booking/bookingId.
      'booking.confirmed': this.audited('booking.confirmed', (p) => ({
        actorId: 'system',
        resourceType: 'booking',
        resourceId: p.bookingId,
      })),
      // Cancelación: forma (A) cancela una OFERTA (PublishedTrip, lleva driverId+publishedTripId, sin bookingId) → actor=driverId,
      // recurso=published_trip. forma (B) cancela un BOOKING individual (lleva bookingId+razon, automática por cobro) →
      // actor='system', recurso=booking/bookingId. Se discrimina por presencia de bookingId (aditivo · ADR-014 §5.4/§6).
      'booking.cancelled': this.audited('booking.cancelled', (p) =>
        p.bookingId
          ? { actorId: 'system', resourceType: 'booking', resourceId: p.bookingId }
          : {
              actorId: p.driverId ?? 'system',
              resourceType: 'published_trip',
              resourceId: p.publishedTripId ?? 'unknown',
            },
      ),

      // ── B/safety · PÁNICO: fan-out delegado ──
      // Delegación durable del fan-out de SMS de pánico (BR-S05): cadena de custodia de la emergencia. Lo dispara
      // share-service (sistema) → actor='system', recurso=panic/panicId. El payload lleva `geo` + `contactIds`
      // (PII de terceros) + `shareLink`: la proyección los DESCARTA antes del WORM (solo panicId/tripId/passengerId).
      'panic.fanout_requested': this.audited('panic.fanout_requested', (p) => ({
        actorId: 'system',
        resourceType: 'panic',
        resourceId: p.panicId,
      })),

      // ── C/share · enlaces de seguimiento familiar (pilar 4) ──
      // Enlace de seguimiento GENERADO: lo crea share-service para un viaje → actor='system', recurso=share/shareId.
      'share.link_generated': this.audited('share.link_generated', (p) => ({
        actorId: 'system',
        resourceType: 'share',
        resourceId: p.shareId,
      })),
      // Enlace VISTO por un familiar (sin cuenta): acceso anónimo por diseño → actor='system', recurso=share/shareId.
      'share.viewed': this.audited('share.viewed', (p) => ({
        actorId: 'system',
        resourceType: 'share',
        resourceId: p.shareId,
      })),

      // ── C/viaje · EVENTOS CON GEO EN PAYLOAD (ahora SEGUROS vía proyección allowlist: la geo se descarta) ──
      // Pedido de viaje creado (REQUESTED): el pasajero pidió → actor=passengerId, recurso=trip/tripId. El payload
      // lleva origin/destination (geo) PERO la proyección los DESCARTA antes del WORM (solo IDs/fare/flags sobreviven).
      'trip.requested': this.audited('trip.requested', (p) => ({
        actorId: p.passengerId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      // Puja abierta (el pasajero propone precio): actor=passengerId, recurso=trip/tripId. origin (geo) → proyección lo dropea.
      'trip.bid_posted': this.audited('trip.bid_posted', (p) => ({
        actorId: p.passengerId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      // El conductor canceló post-accept → REASSIGNING (re-abre el board): actor=driverId (el que canceló), recurso=trip.
      // origin (geo) → proyección lo dropea.
      'trip.reassigning': this.audited('trip.reassigning', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      // Parada negociada mid-trip (waypoints): el pasajero PROPONE → actor=passengerId; el conductor ACEPTA/RECHAZA →
      // actor=driverId; EXPIRA → actor='system'. recurso=trip/tripId en todos. `point` (geo) → proyección lo dropea.
      'trip.waypoint_proposed': this.audited('trip.waypoint_proposed', (p) => ({
        actorId: p.passengerId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.waypoint_accepted': this.audited('trip.waypoint_accepted', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.waypoint_rejected': this.audited('trip.waypoint_rejected', (p) => ({
        actorId: p.driverId,
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      'trip.waypoint_expired': this.audited('trip.waypoint_expired', (p) => ({
        actorId: 'system',
        resourceType: 'trip',
        resourceId: p.tripId,
      })),
      // Dispatch · oferta difundida a un conductor (FIXED o broadcast de PUJA): actor=driverId, recurso=dispatch/tripId.
      // originLat/originLon (geo) → proyección los dropea.
      'dispatch.offered': this.audited('dispatch.offered', (p) => ({
        actorId: p.driverId,
        resourceType: 'dispatch',
        resourceId: p.tripId,
      })),

      // ── D/metadato · MENSAJERÍA Y NOTIFICACIONES (metadato seguro; el `body`/`to` los dropea la proyección) ──
      // Chat conductor↔pasajero: traza inmutable de QUE existió un mensaje y QUIÉN lo envió, sobre qué viaje.
      // actor=senderId, recurso=chat/tripId. El `body` (texto libre) viaja en el envelope PERO la proyección
      // allowlist lo DESCARTA antes del WORM (sobreviven messageId/tripId/senderId/senderRole/createdAt) → seguro auditarlo.
      'chat.message_sent': this.audited('chat.message_sent', (p) => ({
        actorId: p.senderId,
        resourceType: 'chat',
        resourceId: p.tripId,
      })),

      // Notificación: el riel (FCM/APNs/SMS) ACEPTÓ / ENTREGÓ / FALLÓ un mensaje. Todo automático → actor='system',
      // recurso=notification/notificationId. El `to` (token/teléfono/email crudo) y el `error` técnico los DESCARTA
      // la proyección (solo id + canal sobreviven al WORM).
      'notification.sent': this.audited('notification.sent', (p) => ({
        actorId: 'system',
        resourceType: 'notification',
        resourceId: p.notificationId,
      })),
      'notification.delivered': this.audited('notification.delivered', (p) => ({
        actorId: 'system',
        resourceType: 'notification',
        resourceId: p.notificationId,
      })),
      'notification.failed': this.audited('notification.failed', (p) => ({
        actorId: 'system',
        resourceType: 'notification',
        resourceId: p.notificationId,
      })),

      // ─────────────────────────────────────────────────────────────────────────────────────────────
      // AUDIT_EXCLUSIONS — los ÚNICOS eventos de EVENT_SCHEMAS deliberadamente NO auditados, con su razón.
      // El test de cobertura (audit.consumer.coverage.spec.ts) exige que TODO evento de EVENT_SCHEMAS esté
      // acá O tenga handler arriba: un evento nuevo sin decisión ROMPE el test (anti-drift "todo todo").
      //
      //  CONTEXTO: el WORM persiste el payload del evento, PERO ahora pasa por `projectAuditPayload`
      //  (allowlist tipada · audit.service.recordFromEvent), que descarta TODA PII (geo/body/to/phone/email/
      //  contactIds…) antes de la fila inmutable. Por eso la PII YA NO es razón de exclusión: geo, chat y
      //  notification SÍ se auditan (su payload se proyecta a campos seguros). Las exclusiones de abajo NO son
      //  por PII — son por VOLUMEN (firehose) o porque el evento NO representa una mutación de negocio auditable.
      //
      //  FIREHOSE (el volumen explota la hash-chain inmutable + la vuelve un tracker de ubicación, valor forense
      //  nulo: la geo de un viaje se reconstruye de las transiciones del viaje, no de cada ping):
      //   · driver.location_updated  — 1 ping/~15s por CADA conductor online; cientos/seg. Auditarlo encadenaría
      //     millones de eslabones de hash sin valor forense, degradando el append serializado (advisory lock global).
      //   · driver.entered_zone      — geofence de alta frecuencia por conductor; señal de tracking de dispatch,
      //     no un cambio de estado de negocio. Mismo problema de volumen/ruido que el ping de ubicación.
      //   · driver.went_offline      — DEUDA: excluido TEMPORALMENTE, NO definitivo. VEO_SPEC_ADMIN exige "auditar
      //     TODA mutación" y la rama `shift_end` (el conductor cierra turno a propósito) ES una mutación deliberada
      //     que DEBE ir al WORM. Hoy el evento mezcla `shift_end` (identity, outbox) con `disconnect` (driver-bff,
      //     best-effort SIN outbox, firehose-adjacent que se dispara seguido por reconexiones) en un solo tipo, y no
      //     tiene par `went_online` → auditar la mitad OFFLINE mezclada no da cadena de custodia limpia.
      //     DEUDA: auditar la rama shift_end del offline del conductor (traza WORM de fin de turno). · techo: mientras
      //     el evento mezcle shift_end+disconnect en un solo tipo sin par went_online. · gatillo: separar las ramas
      //     (o agregar went_online) → auditar shift_end con actor=driverId, resource=driver, projection [driverId,reason,at].
      //
      //  NO ES UNA MUTACIÓN DE NEGOCIO AUDITABLE:
      //   · audit.recorded — lo EMITE este propio servicio (señal de que se grabó un eslabón); auditarlo sería un
      //     bucle infinito (auditar la auditoría). NO se consume acá por diseño.
      //   · fleet.document_expiring — pre-aviso de vencimiento (30/15/7/1 días), NO un vencimiento. El cambio de
      //     estado real es fleet.document_expired (que SÍ se audita). Es un recordatorio, no una mutación.
      // ─────────────────────────────────────────────────────────────────────────────────────────────
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
        this.logger.error(
          { err, eventType: type, eventId: envelope.eventId },
          'fallo al auditar evento',
        );
        throw err;
      }
    };
  }
}
