/**
 * Consumidor Kafka de identity para el CICLO DE VIDA de cumplimiento del conductor (suspensión↔reactivación).
 *  - `fleet.driver_suspended` → fleet-service suspende al conductor cuando un documento crítico o la ITV
 *    vence; identity escribe `Driver.suspendedAt`, que es lo que el gate de inicio de turno (startShift) lee
 *    para BLOQUEAR el turno (BR-I02). Sin este consumidor la suspensión por documento vencido era código
 *    muerto: nadie escribía `suspendedAt`.
 *  - `fleet.driver_reactivated` → fleet-service avisa que el conductor REGULARIZÓ (ITV nueva vigente o
 *    documento crítico de vuelta a VALID); identity QUITA el hold de ESA causa (DOCUMENT_EXPIRED de ese
 *    documentType, o INSPECTION_EXPIRED) y RECOMPUTA `Driver.suspendedAt` derivado. Fail-closed por modelo de
 *    HOLDS: cada vía quita SOLO su hold → una DISCIPLINARY (u otra causa) queda intacta y el conductor sigue
 *    suspendido si quedan holds. Cierra el ciclo: la suspensión por documento/ITV dejó de ser puerta de una
 *    sola vía. (El difunto `suspensionSource` fue DROPeado con el refactor a holds: la causa vive ahora en el
 *    hold, no en un campo escalar del Driver.)
 *
 * Los eventType casan con EVENT_SCHEMAS (guion bajo) → el KafkaEventConsumer YA valida el payload; igual
 * revalidamos acá con los zod `fleetDriverSuspended`/`fleetDriverReactivated` (defensa en profundidad) para
 * extraer los campos tipados.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS
 * sus eventos en `handlers()` (por eso ambos eventos de fleet viven en ESTE consumer, mismo groupId).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  fleetDriverSuspended,
  fleetDriverReactivated,
  driverFlagged,
  driverExcessiveCancellations,
  driverSuspended,
  driverDebtExceeded,
  driverDebtCleared,
  FLAG_REASON,
  type EventEnvelope,
  type EventHandler,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { domainEventsTotal, BusinessEventResult } from '@veo/observability';
import { DriversService, type SuspensionResealOutcome } from './drivers.service';
import type { Env } from '../config/env.schema';

/** eventType en el wire que emite fleet-service (ver services/fleet-service/src/events/fleet-events.ts). */
const DRIVER_SUSPENDED = 'fleet.driver_suspended';
const DRIVER_REACTIVATED = 'fleet.driver_reactivated';
/**
 * eventType que emite rating-service cuando un conductor cruza un umbral de flag (BR-D01). topicForEvent lo
 * mapea al topic 'driver' (no 'rating'): al registrar este handler, el bootstrap suscribe ESTE consumer a UN
 * topic MÁS ('driver') sobre el MISMO groupId — un consumer / múltiples topics, que es el patrón soportado por
 * el bootstrap (la REGLA DE ORO prohíbe DOS consumers del mismo groupId en topics distintos, no esto).
 */
const DRIVER_FLAGGED = 'driver.flagged';
/**
 * eventType que emite dispatch-service cuando un conductor cruza el umbral de cancelaciones en la ventana rolling
 * de 24h (auto-suspensión por exceso). `topicForEvent` lo mapea al topic 'driver' (corta antes del punto), el MISMO
 * que driver.flagged/suspended/reactivated → este consumer ya está suscrito a 'driver', solo agrega el handler.
 */
const DRIVER_EXCESSIVE_CANCELLATIONS = 'driver.excessive_cancellations';
/**
 * eventType que emite el PROPIO identity por OUTBOX al suspender disciplinariamente a un conductor (`suspend()`).
 * `topicForEvent` lo mapea al topic 'driver' (el MISMO al que este consumer ya está suscrito por driver.flagged/
 * excessive_cancellations) → self-consume sin abrir topic ni groupId nuevo. Es el BACKSTOP DURABLE del revoke:
 * el relay entrega el evento at-least-once, y este handler resella `revoked:before:{userId}` si el post-commit
 * best-effort de `suspend()` no llegó a correr (crash entre COMMIT y sello en Redis → token vivo ≤15m).
 * Distinto de `DRIVER_SUSPENDED` ('fleet.driver_suspended', suspensión AUTOMÁTICA de fleet, otra vía/otro topic).
 */
const DRIVER_SUSPENDED_SELF = 'driver.suspended';
/**
 * ADR-022 §P-A · eventos que emite PAYMENT-service (dueño de la DEUDA) cuando un conductor cruza / salda el tope de
 * deuda por comisiones CASH. `topicForEvent` los mapea al topic 'driver' (cortan antes del punto) — el MISMO al que
 * este consumer ya está suscrito por driver.flagged/suspended → solo agregan sus handlers. identity es el dueño del
 * ESTADO: materializa/quita el hold DEBT_BLOCKED (→ `Driver.suspendedAt` derivado) que el gate de startShift y el
 * eligibility gate de dispatch/booking ya honran. dispatch consume los MISMOS eventos para la exclusión del pool.
 */
const DRIVER_DEBT_EXCEEDED = 'driver.debt_exceeded';
const DRIVER_DEBT_CLEARED = 'driver.debt_cleared';

/**
 * Mapea el desenlace de dominio del reseal a su label de negocio de `domain_events_total` (cero strings mágicos;
 * el `satisfies` garantiza cobertura exhaustiva de `SuspensionResealOutcome`). Disjunto del `result` de transporte
 * (CONSUMED) que el base emite encima. RECONCILED = el backstop cerró la ventana; DUPLICATE = fast-path ya selló;
 * SKIPPED = sin userId resoluble.
 */
const RESEAL_RESULT = {
  reconciled: BusinessEventResult.RECONCILED,
  duplicate: BusinessEventResult.DUPLICATE,
  skipped: BusinessEventResult.SKIPPED,
} as const satisfies Record<SuspensionResealOutcome, string>;

/**
 * Razón del flag de rating que identity DISCRIMINA: el VALOR canónico es `FLAG_REASON` del CONTRATO `@veo/events`
 * (el mismo enum que tipa el payload de `driver.flagged` y rechaza un reason desconocido en el parse) — cero magic
 * strings en el `===`, una sola lista compartida con rating-service. Solo 'suspension' dispara la AUTO-suspensión
 * (hold RATING_LOW); 'review' (y cualquier otra) es flag de PANEL → identity la IGNORA para suspensión. El MÍNIMO
 * de reseñas ya lo aplicó rating-service: si llegó 'suspension', identity confía y materializa el hold (no re-evalúa).
 */

/** clientId kafkajs de este consumer (también su groupId, propio: no comparte el de referidos). */
const KAFKA_CLIENT_ID = 'identity-service-driver-suspension';
const GROUP_ID = 'identity-service-driver-suspension';

@Injectable()
export class DriverSuspensionConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly drivers: DriversService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /**
   * on() resuelve el topic vía topicForEvent: 'fleet.*' → topic 'fleet'; 'driver.flagged' → topic 'driver'. El
   * dispatch interno casa por envelope.eventType. Este consumer queda suscrito a DOS topics (fleet + driver) en
   * un solo groupId (un consumer / múltiples topics: el patrón soportado, no la REGLA DE ORO que prohíbe lo inverso).
   */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      [DRIVER_SUSPENDED]: (env) => this.onDriverSuspended(env),
      [DRIVER_REACTIVATED]: (env) => this.onDriverReactivated(env),
      [DRIVER_FLAGGED]: (env) => this.onDriverFlagged(env),
      [DRIVER_EXCESSIVE_CANCELLATIONS]: (env) => this.onDriverExcessiveCancellations(env),
      [DRIVER_SUSPENDED_SELF]: (env) => this.onDriverSuspendedReseal(env),
      [DRIVER_DEBT_EXCEEDED]: (env) => this.onDriverDebtExceeded(env),
      [DRIVER_DEBT_CLEARED]: (env) => this.onDriverDebtCleared(env),
    };
  }

  protected override subscriptionLog(): string {
    return `Consumidor de ciclo de cumplimiento del conductor iniciado (${DRIVER_SUSPENDED}, ${DRIVER_REACTIVATED}, ${DRIVER_FLAGGED}, ${DRIVER_EXCESSIVE_CANCELLATIONS}, ${DRIVER_SUSPENDED_SELF}, ${DRIVER_DEBT_EXCEEDED}, ${DRIVER_DEBT_CLEARED})`;
  }

  private async onDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = fleetDriverSuspended.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_SUSPENDED} con payload inválido; descartado`);
      return;
    }
    const { driverId, userId, suspendedAt, reason, documentType, holdCause } = parsed.data;
    const at = new Date(suspendedAt);
    if (Number.isNaN(at.getTime())) {
      this.logger.warn(`${DRIVER_SUSPENDED} con suspendedAt inválido (${suspendedAt}); descartado`);
      return;
    }
    // SEAM catálogo↔operabilidad (ADR 013): con `holdCause='CATEGORY_DISABLED'`, el DISCRIMINADOR EXPLÍCITO gana
    // sobre el ruteo por-clave (userId ya significa ITV). fleet keyea la suspensión de catálogo por `userId`
    // (= Vehicle.driverId) → identity lo resuelve a Driver.id y materializa un hold CATEGORY_DISABLED, coexistiendo
    // con documento/ITV/rating. Idempotente (unique del hold). Sin userId (payload malformado) → warn + skip.
    if (holdCause === 'CATEGORY_DISABLED') {
      if (!userId) {
        this.logger.warn(`${DRIVER_SUSPENDED} holdCause=CATEGORY_DISABLED sin userId; descartado`);
        return;
      }
      try {
        const applied = await this.drivers.suspendByFleetCategory(userId, at);
        if (applied) this.logger.log(`Conductor user:${userId} suspendido (${reason})`);
      } catch (err) {
        this.logger.error({ err }, `Falló la suspensión por catálogo del conductor user:${userId}`);
        throw err; // que Kafka reintente; suspendByFleetCategory es idempotente.
      }
      return;
    }
    // DOS VÍAS según el ORIGEN (el refine del schema garantiza EXACTAMENTE una) → cada una keyea una CAUSA
    // de hold DISTINTA (modelo de HOLDS), así regularizar una NUNCA quita la otra:
    //  - `driverId` (id de PERFIL Driver) → suspensión por DOCUMENTO crítico vencido → hold DOCUMENT_EXPIRED
    //    con causeRef = `documentType` (SOAT/LICENSE_A1/PROPERTY_CARD): UN hold por documento distinto. El
    //    sweeper SIEMPRE manda `documentType` en esta vía; si faltara, 'UNKNOWN' es un causeRef honesto (no
    //    colapsa con otros docs reales y mantiene la idempotencia por el natural key).
    //  - `userId` (User.id = `Vehicle.driverId`) → suspensión por INSPECCIÓN técnica (ITV) vencida → hold
    //    INSPECTION_EXPIRED (causeRef ''). identity resuelve User.id → Driver.id en `suspendByFleetForUser`.
    //    fleet NUNCA manda un User.id en `driverId` (el bug a evitar). El zod ya rechazó payloads ambiguos.
    const subject = driverId ?? `user:${userId ?? '?'}`;
    try {
      const applied = driverId
        ? await this.drivers.suspendByFleet(driverId, at, documentType ?? 'UNKNOWN')
        : await this.drivers.suspendByFleetForUser(userId as string, at);
      if (applied) {
        this.logger.log(`Conductor ${subject} suspendido (${reason})`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló la suspensión del conductor ${subject}`);
      throw err; // que Kafka reintente; suspendByFleet/suspendByFleetForUser son idempotentes.
    }
  }

  /**
   * INVERSA de onDriverSuspended: el conductor regularizó (ITV nueva vigente o documento crítico de vuelta a
   * VALID). Mismo ruteo XOR según el ORIGEN (el refine del schema garantiza EXACTAMENTE una):
   *  - `driverId` (id de PERFIL Driver) → regularización por DOCUMENTO. Reactiva directo (reactivateByFleet).
   *  - `userId` (User.id = `Vehicle.driverId`) → regularización por ITV. identity es el dueño del mapeo
   *    User.id → Driver.id y lo resuelve en reactivateByFleetForUser. fleet NUNCA manda un User.id en
   *    `driverId` (mismo filo que la suspensión: confundirlos reactivaría al conductor equivocado).
   *
   * IDEMPOTENTE y FAIL-CLOSED (modelo de HOLDS): cada vía quita SOLO el hold de SU causa — `reactivateByFleet`
   * quita el DOCUMENT_EXPIRED de ESE `documentType`; `reactivateByFleetForUser` quita el INSPECTION_EXPIRED. Las
   * otras causas (otro documento, ITV, DISCIPLINARY) quedan intactas → si quedan holds, el conductor SIGUE
   * suspendido. Es no-op si el hold ya no existe (re-entregas / ya regularizado).
   */
  private async onDriverReactivated(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = fleetDriverReactivated.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_REACTIVATED} con payload inválido; descartado`);
      return;
    }
    const { driverId, userId, reason, documentType, holdCause } = parsed.data;
    // SEAM catálogo↔operabilidad (espejo de la suspensión): con `holdCause='CATEGORY_DISABLED'` la clase volvió a
    // ser operable (el admin re-activó la oferta) → quita SOLO el hold CATEGORY_DISABLED (por userId), NUNCA el de
    // ITV. Es la ÚNICA vía que levanta ese hold. Idempotente (borrar 0 = no-op). Sin userId → warn + skip.
    if (holdCause === 'CATEGORY_DISABLED') {
      if (!userId) {
        this.logger.warn(`${DRIVER_REACTIVATED} holdCause=CATEGORY_DISABLED sin userId; descartado`);
        return;
      }
      try {
        const applied = await this.drivers.reactivateByFleetCategory(userId);
        if (applied) this.logger.log(`Conductor user:${userId} reincorporado (${reason})`);
      } catch (err) {
        this.logger.error(
          { err },
          `Falló la reincorporación por catálogo del conductor user:${userId}`,
        );
        throw err; // que Kafka reintente; reactivateByFleetCategory es idempotente.
      }
      return;
    }
    const subject = driverId ?? `user:${userId ?? '?'}`;
    try {
      // driverId → regularización por DOCUMENTO: quita SOLO el hold de ESE documentType (el evento lo lleva).
      // userId → regularización por ITV: quita SOLO el hold INSPECTION_EXPIRED. Causas distintas, holds distintos.
      const applied = driverId
        ? await this.drivers.reactivateByFleet(driverId, documentType ?? 'UNKNOWN')
        : await this.drivers.reactivateByFleetForUser(userId as string);
      if (applied) {
        this.logger.log(`Conductor ${subject} reactivado (${reason})`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló la reactivación del conductor ${subject}`);
      throw err; // que Kafka reintente; reactivateByFleet/reactivateByFleetForUser son idempotentes.
    }
  }

  /**
   * AUTO-suspensión por RATING bajo (BR-D01 · decisión del dueño · compliance/seguridad). rating-service ya
   * decidió: solo emite reason='suspension' cuando avg < 4.0 Y count ≥ MÍNIMO de reseñas; identity NO re-evalúa,
   * solo MATERIALIZA. El `driver.flagged.driverId` es el id de PERFIL Driver (= `Trip.driverId`, invariante
   * verificado en trip-service) → se usa DIRECTO, sin resolver por userId.
   *
   *  - reason 'suspension' → addHold RATING_LOW (idempotente, con guard de existencia anti poison-pill).
   *  - reason 'review' (u otra) → NO suspende: es flag de PANEL. Se ignora para suspensión (sin error: el evento
   *    es legítimo, solo no dispara el hold).
   *
   * NO auto-reactiva en recuperación: la decisión del dueño es reactivación MANUAL (el operador levanta el hold
   * RATING_LOW por la vía de compliance, reactivateForCompliance). Por eso este consumer NUNCA quita el hold.
   */
  private async onDriverFlagged(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverFlagged.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_FLAGGED} con payload inválido; descartado`);
      return;
    }
    const { driverId, reason } = parsed.data;
    // Solo 'suspension' suspende. 'review' (y cualquier otra razón futura) es flag de panel → no-op de suspensión.
    if (reason !== FLAG_REASON.SUSPENSION) {
      this.logger.debug(
        `${DRIVER_FLAGGED} reason='${reason}' (no es suspensión); ignorado para suspender`,
      );
      return;
    }
    try {
      const applied = await this.drivers.suspendByRating(
        driverId,
        `Rating bajo sostenido (auto-suspensión BR-D01)`,
      );
      if (applied) {
        this.logger.log(`Conductor ${driverId} auto-suspendido por rating bajo`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló la auto-suspensión por rating del conductor ${driverId}`);
      throw err; // que Kafka reintente; suspendByRating es idempotente.
    }
  }

  /**
   * AUTO-suspensión por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad). dispatch-service ya
   * decidió: emite `driver.excessive_cancellations` SOLO al cruzar el umbral en la ventana rolling de 24h; identity
   * NO re-evalúa, solo MATERIALIZA un hold TEMPORAL EXCESSIVE_CANCELLATIONS con `expiresAt = now + cooldown` (el
   * sweeper lo auto-levanta al vencer). El `driverId` del evento es el id de PERFIL Driver (= `Trip.driverId`) → se
   * usa DIRECTO, sin resolver por userId (igual que driver.flagged).
   *
   * NO auto-reactiva por código acá: el cooldown lo levanta el SWEEPER (HoldExpirySweeper); el operador puede
   * levantarlo antes vía compliance (reactivateForCompliance). Por eso este handler NUNCA quita el hold.
   * Idempotente: una re-entrega es un upsert no-op y NO extiende el cooldown (la garantía vive en addHold).
   */
  private async onDriverExcessiveCancellations(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverExcessiveCancellations.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_EXCESSIVE_CANCELLATIONS} con payload inválido; descartado`);
      return;
    }
    const { driverId, count } = parsed.data;
    try {
      const applied = await this.drivers.suspendByCancellations(
        driverId,
        `Exceso de cancelaciones (${count} en ventana rolling; auto-suspensión temporal)`,
      );
      if (applied) {
        this.logger.log(
          `Conductor ${driverId} auto-suspendido por exceso de cancelaciones (${count})`,
        );
      }
    } catch (err) {
      this.logger.error(
        { err },
        `Falló la auto-suspensión por cancelaciones del conductor ${driverId}`,
      );
      throw err; // que Kafka reintente; suspendByCancellations es idempotente.
    }
  }

  /**
   * BACKSTOP DURABLE de la revocación de sesión (crash-window MEDIA). identity emite `driver.suspended` por
   * OUTBOX en la MISMA tx que la suspensión disciplinaria (`suspend()`) y mata la sesión/socket en un post-commit
   * best-effort. Si identity CRASHEA entre el COMMIT y ese sello en Redis, el denylist `revoked:before:{userId}`
   * queda SIN sellar → el access token vivo del conductor pasa el guard HTTP hasta vencer (≤15m). Este handler,
   * alimentado por la entrega at-least-once del relay, RESELLA idempotentemente cuando el evento llega:
   *  - Camino feliz (sin crash): el fast-path ya selló `now() ≥ suspendedAt` → el reseal es no-op ('duplicate').
   *  - Crash: el reseal ELEVA el sello al `suspendedAt` del evento ('reconciled') → cierra la ventana.
   * El sello es al `suspendedAt` del EVENTO (no `now()`) y MONOTÓNICO → reprocesar converge al MISMO sello
   * (idempotente + determinista). Un error transitorio de Redis se RELANZA para que Kafka reintente (durabilidad).
   */
  private async onDriverSuspendedReseal(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverSuspended.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_SUSPENDED_SELF} con payload inválido; descartado`);
      return;
    }
    const { driverId, userId, suspendedAt } = parsed.data;
    const at = new Date(suspendedAt);
    if (Number.isNaN(at.getTime())) {
      this.logger.warn(
        `${DRIVER_SUSPENDED_SELF} con suspendedAt inválido (${suspendedAt}); descartado`,
      );
      return;
    }
    try {
      const outcome: SuspensionResealOutcome = await this.drivers.resealSuspensionRevocation(
        driverId,
        userId,
        at,
      );
      domainEventsTotal.inc({ event: DRIVER_SUSPENDED_SELF, result: RESEAL_RESULT[outcome] });
      if (outcome === 'reconciled') {
        // El fast-path NO había sellado → el backstop cerró la crash-window. Señal de que hubo un crash
        // (o el post-commit falló) entre el COMMIT de la suspensión y el revoke: worth un WARN para Ops.
        this.logger.warn(
          `Backstop: resellé revoked-before del conductor ${driverId} (el revoke post-commit no había corrido)`,
        );
      }
    } catch (err) {
      this.logger.error(
        { err },
        `Falló el reseal de revocación (backstop) del conductor ${driverId}`,
      );
      throw err; // que Kafka reintente; el reseal es idempotente y monotónico (no corrompe al reprocesar).
    }
  }

  /**
   * ADR-022 §P-A · BLOQUEO por DEUDA: payment-service reportó que el conductor cruzó el tope de deuda CASH. identity
   * materializa el hold DEBT_BLOCKED (→ `Driver.suspendedAt`) que bloquea el próximo turno + el accept/oferta. NO
   * revoca la sesión (bloqueo tipo A: el viaje en curso se termina normal); la exclusión del pool la hace dispatch
   * con el MISMO evento. Idempotente (el @@unique del hold). Un error de DB es transitorio → relanza → Kafka reintenta.
   */
  private async onDriverDebtExceeded(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverDebtExceeded.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_DEBT_EXCEEDED} con payload inválido; descartado`);
      return;
    }
    const { driverId, totalDebtCents, thresholdCents } = parsed.data;
    try {
      const applied = await this.drivers.blockForDebt(driverId, totalDebtCents, thresholdCents);
      if (applied) {
        this.logger.log(
          `Conductor ${driverId} bloqueado por deuda de comisiones (${totalDebtCents}c > ${thresholdCents}c)`,
        );
      }
    } catch (err) {
      this.logger.error({ err }, `Falló el bloqueo por deuda del conductor ${driverId}`);
      throw err; // que Kafka reintente; blockForDebt es idempotente (@@unique del hold).
    }
  }

  /**
   * ADR-022 §P-A · DESBLOQUEO por DEUDA: el conductor SALDÓ por el rail (payment capturó la liquidación). identity
   * quita el hold DEBT_BLOCKED y recomputa `suspendedAt` (si quedan otros holds, sigue suspendido). NO emite
   * `driver.reactivated`: dispatch reincorpora al pool con el MISMO evento (holds-aware). Idempotente (borrar 0 =
   * no-op). Un error de DB es transitorio → relanza → Kafka reintenta.
   */
  private async onDriverDebtCleared(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverDebtCleared.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_DEBT_CLEARED} con payload inválido; descartado`);
      return;
    }
    const { driverId } = parsed.data;
    try {
      const applied = await this.drivers.clearDebtBlock(driverId);
      if (applied) {
        this.logger.log(`Conductor ${driverId} desbloqueado: saldó su deuda de comisiones`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló el desbloqueo por deuda del conductor ${driverId}`);
      throw err; // que Kafka reintente; clearDebtBlock es idempotente (borrar 0 holds = no-op).
    }
  }
}
