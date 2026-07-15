/**
 * Consumidor Kafka de identity para el CICLO DE VIDA DEL VIAJE → eje `Driver.currentStatus` (Fase A · ADR-021).
 *
 * EL FIX RAÍZ del "un viaje por conductor". Hasta hoy NADIE movía `Driver.currentStatus`: el conductor quedaba
 * AVAILABLE durante todo el viaje, así que el `eligibility.gate` de dispatch (AVAILABLE-only) lo dejaba GANAR
 * boards concurrentes → doble-win. Este consumer cierra el eje: al asignarse/aceptar/arrancar un viaje el
 * conductor pasa a ASSIGNED/ON_TRIP (deja de ser AVAILABLE → el gate lo rechaza para un 2º viaje), y al
 * cerrarse el viaje por CUALQUIER vía terminal vuelve a AVAILABLE (release del pool).
 *
 * Mapeo evento → estado destino:
 *  - trip.assigned                                   → ASSIGNED  (el conductor ganó/quedó asignado)
 *  - trip.accepted / trip.started                    → ON_TRIP   (el viaje arrancó)
 *  - trip.completed / trip.cancelled / trip.expired /
 *    trip.failed / trip.reassigning                  → AVAILABLE (RELEASE: fin del viaje, vuelve al pool)
 *
 * RESOLUCIÓN DEL driverId: es el id de PERFIL Driver (= `Trip.driverId` = `Driver.id`, mismo espacio que usa
 * el resto de la cadena de suspensión). Los eventos de asignación/arranque/reasignación lo llevan OBLIGATORIO;
 * los terminales (completed/cancelled/expired/failed) lo llevan OPCIONAL (compat N-2 / no siempre había
 * conductor) → sin driverId no hay a quién mover: SKIP seguro.
 *
 * IDEMPOTENTE + FAIL-SAFE: la mudanza va por el CAS derivado de la máquina (`DriversService.moveStatusForTrip`):
 * una transición ilegal desde el estado actual (redelivery, conductor SUSPENDED/OFFLINE) es un NO-OP silencioso,
 * NUNCA un crash del consumer. El `driverId` toca `Driver.id` (`@db.Uuid`): un id no-UUID es VENENO → log +
 * saltar sin reintento (mismo patrón que ReferralsConsumer). Un error PERMANENTE de datos (P2023/…) se salta;
 * lo TRANSITORIO (DB caída/deadlock) se relanza para que Kafka reintente (moveStatusForTrip es idempotente).
 *
 * BOOTSTRAP (createKafka + consumer del group + lifecycle) promovido en KafkaConsumerBootstrap
 * (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS sus eventos en `handlers()`. Todos los
 * eventos de este consumer viven en el MISMO topic `trip` (un consumer / un topic / un groupId propio).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_SCHEMAS,
  isPermanentDataError,
  isUuid,
  type EventEnvelope,
  type EventHandler,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { domainEventsTotal, BusinessEventResult } from '@veo/observability';
import { DriverStatus } from '../generated/prisma';
import { DriversService } from './drivers.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este consumer (también su groupId, propio: no comparte el de suspensión ni referidos). */
const KAFKA_CLIENT_ID = 'identity-service-trip-lifecycle';
const GROUP_ID = 'identity-service-trip-lifecycle';

/**
 * Mapa eventType → estado destino del eje. La CLAVE es el eventType del wire (schema de @veo/events); el VALOR
 * es el `DriverStatus` canónico (enum tipado, cero strings mágicos). Un evento no listado no lo maneja este
 * consumer. Los 5 terminales (completed/cancelled/expired/failed/reassigning) convergen a AVAILABLE (release).
 */
const EVENT_TO_STATUS = {
  'trip.assigned': DriverStatus.ASSIGNED,
  'trip.accepted': DriverStatus.ON_TRIP,
  'trip.started': DriverStatus.ON_TRIP,
  'trip.completed': DriverStatus.AVAILABLE,
  'trip.cancelled': DriverStatus.AVAILABLE,
  'trip.expired': DriverStatus.AVAILABLE,
  'trip.failed': DriverStatus.AVAILABLE,
  'trip.reassigning': DriverStatus.AVAILABLE,
} as const satisfies Partial<Record<keyof typeof EVENT_SCHEMAS, DriverStatus>>;

type TripLifecycleEvent = keyof typeof EVENT_TO_STATUS;

/** Mapea el desenlace del CAS a su label de negocio de `domain_events_total` (disjunto del `result` de transporte). */
const MOVE_RESULT = {
  moved: BusinessEventResult.RECORDED,
  noop: BusinessEventResult.SKIPPED,
} as const;

@Injectable()
export class TripLifecycleConsumer extends KafkaConsumerBootstrap {
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

  /** TODOS los eventos del group, en un solo record (único punto de registro). Todos en el topic `trip`. */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return Object.fromEntries(
      (Object.keys(EVENT_TO_STATUS) as TripLifecycleEvent[]).map((eventType) => [
        eventType,
        (env: EventEnvelope<unknown>) => this.applyTransition(eventType, env),
      ]),
    );
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Consumidor de ciclo de vida del viaje → estado del conductor iniciado (${eventTypes.join(', ')})`;
  }

  /**
   * Aplica la transición del eje para un evento del viaje. Resuelve el driverId del payload (opcional en los
   * terminales), guarda el borde @db.Uuid, y mueve el estado por el CAS idempotente + fail-safe.
   */
  private async applyTransition(
    eventType: TripLifecycleEvent,
    env: EventEnvelope<unknown>,
  ): Promise<void> {
    const parsed = EVENT_SCHEMAS[eventType].safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${eventType} con payload inválido; descartado`);
      return;
    }
    // Los eventos de asignación/arranque/reasignación llevan driverId OBLIGATORIO; los terminales (completed/
    // cancelled/expired/failed) lo llevan OPCIONAL — sin conductor no hay a quién mover: SKIP honesto.
    const driverId = (parsed.data as { driverId?: string }).driverId;
    if (!driverId) {
      domainEventsTotal.inc({ event: eventType, result: BusinessEventResult.NO_DRIVER });
      return;
    }
    // `driverId` toca `Driver.id` (@db.Uuid): un id malformado → Prisma P2023 → crash-loop de la partición.
    // Guardamos el borde ANTES de tocar Prisma (mismo patrón que ReferralsConsumer): no-UUID = veneno → saltar.
    if (!isUuid(driverId)) {
      this.logger.error(
        `POISON ${eventType}: driverId no-UUID "${String(driverId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: eventType, result: BusinessEventResult.REJECTED });
      return;
    }
    const to = EVENT_TO_STATUS[eventType];
    try {
      const outcome = await this.drivers.moveStatusForTrip(driverId, to);
      domainEventsTotal.inc({ event: eventType, result: MOVE_RESULT[outcome] });
      if (outcome === 'moved') {
        this.logger.log(`Conductor ${driverId} → ${to} (por ${eventType})`);
      } else {
        // NO-OP legítimo (transición ilegal desde el estado actual: redelivery, SUSPENDED/OFFLINE, etc.).
        this.logger.debug(
          `${eventType}: transición a ${to} no aplicable al conductor ${driverId} (no-op)`,
        );
      }
    } catch (err) {
      // Veneno de datos (P2023/P2009/…) → saltar sin reintento; lo transitorio (DB caída, deadlock) se relanza
      // para que Kafka reintente (moveStatusForTrip es idempotente por el CAS derivado de la máquina).
      if (isPermanentDataError(err)) {
        this.logger.error(
          { err },
          `POISON ${eventType}: error permanente de datos moviendo al conductor ${driverId} (eventId=${env.eventId}); descartado sin reintento`,
        );
        domainEventsTotal.inc({ event: eventType, result: BusinessEventResult.REJECTED });
        return;
      }
      this.logger.error(
        { err },
        `Falló la transición de estado del conductor ${driverId} por ${eventType}`,
      );
      throw err;
    }
  }
}
