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
  FLAG_REASON,
  type EventEnvelope,
  type EventHandler,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { DriversService } from './drivers.service';
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
    };
  }

  protected override subscriptionLog(): string {
    return `Consumidor de ciclo de cumplimiento del conductor iniciado (${DRIVER_SUSPENDED}, ${DRIVER_REACTIVATED}, ${DRIVER_FLAGGED})`;
  }

  private async onDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = fleetDriverSuspended.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_SUSPENDED} con payload inválido; descartado`);
      return;
    }
    const { driverId, userId, suspendedAt, reason, documentType } = parsed.data;
    const at = new Date(suspendedAt);
    if (Number.isNaN(at.getTime())) {
      this.logger.warn(`${DRIVER_SUSPENDED} con suspendedAt inválido (${suspendedAt}); descartado`);
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
    const { driverId, userId, reason, documentType } = parsed.data;
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
      this.logger.debug(`${DRIVER_FLAGGED} reason='${reason}' (no es suspensión); ignorado para suspender`);
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
}
