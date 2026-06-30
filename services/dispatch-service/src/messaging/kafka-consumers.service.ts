/**
 * Consumidores Kafka de dispatch-service. Valida cada payload contra @veo/events y enruta:
 *  - trip.requested          → registra demanda surge + lanza el matching (BR-T06).
 *  - driver.location_updated → actualiza el hot index (ubicación + celda H3).
 *  - panic.triggered         → excluye al conductor del viaje en pánico (prioridad de pánico).
 *  - rating.created          → proyección de rating del conductor.
 *  - driver.flagged          → proyección de rating (valor impuesto).
 *  - trip.completed          → proyección (último viaje) + reincorpora al conductor al pool.
 *  - trip.cancelled          → proyección de cancelación (solo si la cancela el conductor PRE-accept).
 *  - trip.reassigning        → re-abre el board + libera al conductor + CUENTA la cancelación POST-accept
 *                              (la abusiva: aceptó y abandonó) en la MISMA ventana de auto-suspensión.
 *
 * El matching es de larga duración (ofertas secuenciales con timeout): se lanza sin bloquear el
 * commit del consumidor; sus efectos durables (matches, eventos) se persisten igual.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS
 * sus eventos en `handlers()`.
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
import { VehicleClass } from '@veo/shared-types';
import { DispatchService } from '../dispatch/dispatch.service';
import { MatchingService } from '../dispatch/matching.service';
import { SurgeService } from '../dispatch/surge.service';
import { DriverProjectionService } from '../dispatch/driver-projection.service';
import { DriverSuspensionService } from '../dispatch/driver-suspension.service';
import { OfferBoardService } from '../dispatch/offer-board.service';
import { HeatmapService } from '../heatmap/heatmap.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio (también su groupId de consumo). */
const KAFKA_CLIENT_ID = 'dispatch-service';
const GROUP_ID = 'dispatch-service';

@Injectable()
export class KafkaConsumersService extends KafkaConsumerBootstrap {
  constructor(
    config: ConfigService<Env, true>,
    private readonly dispatch: DispatchService,
    private readonly matching: MatchingService,
    private readonly surge: SurgeService,
    private readonly projection: DriverProjectionService,
    private readonly suspensionService: DriverSuspensionService,
    private readonly offerBoard: OfferBoardService,
    private readonly heatmap: HeatmapService,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'trip.requested': (env) => this.onTripRequested(env),
      // PUJA (ADR 010 · Lote B): el board consume el bid del pasajero y la re-apertura tras cancel.
      // Lote C: trip-service emitirá `trip.bid_posted`; hoy el board lo consume en aislamiento, sin
      // tocar el camino legacy `trip.requested`→matching auto-secuencial.
      'trip.bid_posted': (env) => this.onBidPosted(env),
      'trip.reassigning': (env) => this.onReassigning(env),
      'driver.location_updated': (env) => this.onDriverLocation(env),
      'panic.triggered': (env) => this.onPanic(env),
      // SUSPENSIÓN (eje disciplinario): el conductor sale/entra del pool de matching. El `accept` ya lo
      // frena fail-closed; esto cierra la MEMBRESÍA (no ofertarle a un suspendido que sigue pingeando GPS).
      'driver.suspended': (env) => this.onDriverSuspended(env),
      'driver.reactivated': (env) => this.onDriverReactivated(env),
      // SUSPENSIÓN por el eje FLEET (doc/ITV vencido): MISMA exclusión del pool que el eje disciplinario.
      // El sujeto llega por clave DUAL (driverId de perfil XOR userId=User.id de la vía ITV) → el service
      // resuelve a Driver.id. Cierra la under-exclusion del eje doc/ITV (Lote 2b). Suscribe el topic `fleet`.
      'fleet.driver_suspended': (env) => this.onFleetDriverSuspended(env),
      'fleet.driver_reactivated': (env) => this.onFleetDriverReactivated(env),
      'rating.created': (env) => this.onRating(env),
      'driver.flagged': (env) => this.onDriverFlagged(env),
      'trip.completed': (env) => this.onTripCompleted(env),
      'trip.cancelled': (env) => this.onTripCancelled(env),
    };
  }

  protected override subscriptionLog(): string {
    return 'consumidores Kafka iniciados';
  }

  private async onTripRequested(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.requested'].parse(env.payload);
    await this.surge.recordDemand(p.origin);
    // Ola 2C: alimenta el mapa de calor de demanda por celda H3 (ventana deslizante en Redis).
    await this.heatmap.recordDemand(p.origin);
    // El matching filtra candidatos por clase de vehículo (MOTO solo a conductores MOTO). El default
    // CAR acá es SOLO para eventos legacy pre-Ola 2B aún en el topic (el schema mantiene el campo
    // opcional por compat N-2); post-catálogo (ADR 013 · Lote B) trip-service SIEMPRE lo emite
    // derivado del offering, así que una clase nueva jamás cae acá: viaja explícita en el evento.
    const requiredVehicleType = p.vehicleType ?? VehicleClass.CAR;
    // Abre la sesión de matching (event-driven) y dispara la primera oferta. NO bloquea el commit del
    // consumidor: el desenlace avanza por ESTADO en DB (offerNext desde el reject del conductor / el
    // reconciler de timeout), no por un await-loop con estado en proceso.
    void this.matching
      // B5-3 · category (offeringId) → el matching resuelve los requisitos de eligibilidad de la oferta.
      .startSession({
        tripId: p.tripId,
        origin: p.origin,
        requiredVehicleType,
        category: p.category,
      })
      .catch((err) => this.logger.error(`matching falló para trip ${p.tripId}: ${String(err)}`));
  }

  /**
   * PUJA (ADR 010 §3.2): el pasajero posteó un bid → abre el OfferBoard y difunde a elegibles.
   * Idempotente por tripId (re-abre el mismo board). No bloquea el commit del consumidor.
   */
  private async onBidPosted(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.bid_posted'].parse(env.payload);
    await this.offerBoard.openBoard({
      tripId: p.tripId,
      passengerId: p.passengerId,
      bidCents: p.bidCents,
      vehicleType: p.vehicleType,
      // B5-3 — propaga el tier del viaje al board: el gate deriva `requires` para enforcar la elegibilidad
      // por TIER en PUJA igual que en FIXED. Opcional/compat N-2 (bid_posted previos sin category).
      category: p.category,
      origin: p.origin,
      windowSec: p.windowSec,
      // H13 — propaga el ciclo de negociación al board (se estampa en offer_accepted).
      negotiationSeq: p.negotiationSeq,
      // BE-2 — solicitudes especiales: el board las guarda para que el conductor las vea en /bids/open.
      specialRequests: p.specialRequests ?? [],
    });
  }

  /**
   * PUJA robustez #4: el conductor canceló tras aceptar → trip REASSIGNING. RECONSTRUIMOS el board desde
   * el payload ENRIQUECIDO (no dependemos de la key vieja de Redis, que pudo expirar por TTL) y LIBERAMOS
   * al conductor que canceló del hot-index (estaba markBusy desde la aceptación; sin esto quedaría excluido
   * del matching para siempre). Mirror de onTripCancelled → releaseDriver. Idempotente.
   *
   * AUTO-SUSPENSIÓN (decisión del dueño · contar AMBAS cancelaciones): una cancelación POST-accept es
   * la MÁS abusiva (el conductor aceptó y abandonó al pasajero) y SIEMPRE es culpa del conductor — el
   * schema `tripReassigning` tiene `reason` enum de UN solo valor (`driver_cancelled`), sin ruido de
   * ofertas vencidas. Por eso CUENTA INCONDICIONALMENTE para la misma ventana rolling 24h, reusando el
   * MISMO `registerCancellationInWindow` que `trip.cancelled by=DRIVER` (un único punto que registra +
   * poda + cuenta + emite el cruce de umbral; NO se duplica la lógica de ventana). El `driverId` del
   * payload es de PERFIL (`trip.driverId`, el conductor asignado, mismo espacio que `driverForTrip`),
   * correcto para la cadena de suspensión. Idempotente por el natural key `(driverId, tripId)`: una
   * re-entrega Kafka del mismo evento es no-op (no re-cuenta). `occurredAt` = momento REAL del hecho
   * (del envelope), no el de consumo → la ventana refleja el tiempo de la cancelación.
   */
  private async onReassigning(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.reassigning'].parse(env.payload);
    // ORDEN DELIBERADO — SEGURIDAD PRIMERO: reopenBoard (+ releaseDriver) re-abren el OfferBoard para que el
    // pasajero ABANDONADO consiga otro conductor; es la acción de seguridad y NO debe quedar gateada por un hipo
    // del contador (analítica). Por eso van ANTES que registerCancellationInWindow. Si el conteo falla transitorio,
    // el board YA se re-abrió; el retry de Kafka re-corre AMBOS (reopen idempotente; conteo idempotente por
    // (driverId, tripId), no re-cuenta). Operan sobre Redis (key string, tolera cualquier id).
    if (p.driverId) await this.dispatch.releaseDriver(p.driverId);
    await this.offerBoard.reopenBoard({
      tripId: p.tripId,
      driverId: p.driverId,
      passengerId: p.passengerId,
      vehicleType: p.vehicleType,
      // B5-3 — re-persiste el tier en el board re-abierto para enforcar el TIER en el re-match.
      category: p.category,
      origin: p.origin,
      bidCents: p.bidCents,
      // H13 — el seq del NUEVO ciclo de la reasignación: el board re-abierto lo estampa en offer_accepted.
      negotiationSeq: p.negotiationSeq,
    });
    // Recién AHORA, con el board ya re-abierto, suma esta cancelación POST-accept a la MISMA ventana rolling 24h
    // de la auto-suspensión. El guard `p.driverId` cubre el borde del emisor (manda '' si no había conductor
    // asignado — imposible POST-accept, pero defensa en profundidad: sin id de perfil no se puede atribuir).
    // `tripId` es UUID (toca @db.Uuid en driver_cancellation_events); el schema lo deja como z.string()
    // compartido, así que guardamos el borde igual que onTripCancelled — un id no-UUID es veneno → log ERROR +
    // saltar (el board ya quedó re-abierto).
    if (p.driverId) {
      if (!isUuid(p.tripId)) {
        this.logger.error(
          `POISON trip.reassigning: tripId no-UUID "${String(p.tripId)}" (eventId=${env.eventId}); ` +
            'no se cuenta para la ventana de cancelaciones',
        );
        domainEventsTotal.inc({ event: 'trip.reassigning', result: BusinessEventResult.REJECTED });
        return;
      }
      try {
        await this.projection.registerCancellationInWindow(
          p.driverId,
          p.tripId,
          new Date(env.occurredAt),
        );
      } catch (err) {
        // Error permanente de datos → saltar el conteo (el reopen del board ya ocurrió arriba, el pasajero no
        // queda abandonado). Lo transitorio se relanza para que Kafka reintente AMBOS (reopen idempotente).
        if (isPermanentDataError(err)) {
          this.logger.error(
            `POISON trip.reassigning: error permanente de datos al contar cancelación de ` +
              `${p.driverId} (trip ${p.tripId}, eventId=${env.eventId}); descartado: ${String(err)}`,
          );
          domainEventsTotal.inc({ event: 'trip.reassigning', result: BusinessEventResult.REJECTED });
        } else {
          throw err;
        }
      }
    }
  }

  private async onDriverLocation(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.location_updated'].parse(env.payload);
    // La clase de vehículo activa se proyecta en el hot index para el filtrado del matching. El
    // default CAR es SOLO para pings legacy pre-Ola 2B aún en el topic (campo opcional por compat
    // N-2 en el schema); driver-bff hoy SIEMPRE sella la clase server-authoritative en el evento.
    // B5-3 · attrs de eligibilidad (opcionales): si el ping los trae, dispatch los proyecta en el hot
    // index para filtrar por oferta (confort/xl). Un ping sin ellos no restringe (degradación segura).
    await this.dispatch.ingestLocation(p.driverId, p.point, p.vehicleType ?? VehicleClass.CAR, {
      // Identidad del vehículo activo: key del carry anti-clobber (no vehicleType). Opcional (legacy/204).
      vehicleId: p.vehicleId,
      seats: p.seats,
      segment: p.segment,
      vehicleYear: p.vehicleYear,
      // B5-3.2 · certs vigentes del conductor para gatear las verticales (fail-closed en el pool).
      certifications: p.certifications,
    });
  }

  private async onPanic(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['panic.triggered'].parse(env.payload);
    // HARDENING: `tripId` toca la columna `@db.Uuid` (excludeDriverForPanic → findFirst). Un id
    // malformado envenenaría el topic `panic` (crash-loop). Pánico es safety-critical: si el id es
    // veneno, logueamos en ERROR (alta visibilidad para operación) y saltamos — NO podemos bloquear
    // la partición de pánico de todos los demás viajes por un evento corrupto.
    if (!isUuid(p.tripId)) {
      this.logger.error(
        `POISON panic.triggered: tripId no-UUID "${String(p.tripId)}" (panicId=${p.panicId}, eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'panic.triggered', result: BusinessEventResult.REJECTED });
      return;
    }
    try {
      const driverId = await this.dispatch.excludeDriverForPanic(p.tripId);
      if (driverId)
        this.logger.warn(`pánico en trip ${p.tripId}: conductor ${driverId} excluido del pool`);
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON panic.triggered: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'panic.triggered', result: BusinessEventResult.REJECTED });
        return;
      }
      throw err;
    }
  }

  /**
   * SUSPENSIÓN (eje disciplinario · `driver.suspended` trae `driverId` de PERFIL directo): saca al
   * conductor del pool de matching para no ofertarle (el `accept` ya lo frena fail-closed). El `driverId`
   * viaja como member de un SET de Redis (NO toca columna `@db.Uuid`), así que no hay veneno de tipo; un
   * fallo de Redis es transitorio ⇒ relanza ⇒ kafkajs reintenta. Idempotente (SADD repetido = no-op).
   */
  private async onDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.suspended'].parse(env.payload);
    await this.suspensionService.onSuspended(p.driverId);
  }

  /**
   * REACTIVACIÓN (eje disciplinario): re-valida la suspensión autoritativa en identity (HOLDS-AWARE) y
   * reincorpora al pool SOLO si el conductor quedó sin holds. Un error de red gRPC es transitorio ⇒
   * relanza ⇒ kafkajs re-entrega y la reactivación se re-procesa cuando identity vuelve.
   */
  private async onDriverReactivated(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.reactivated'].parse(env.payload);
    await this.suspensionService.onReactivated(p.driverId);
  }

  /**
   * SUSPENSIÓN por el eje FLEET (doc/ITV): el conductor sale del pool. El sujeto viaja por clave dual
   * (XOR driverId|userId, ver `fleetDriverSuspended`); el service resuelve a Driver.id (User.id → perfil
   * por gRPC en la vía ITV). Un fallo de identity es transitorio ⇒ relanza ⇒ kafkajs reintenta.
   */
  private async onFleetDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['fleet.driver_suspended'].parse(env.payload);
    await this.suspensionService.onFleetSuspended({ driverId: p.driverId, userId: p.userId });
  }

  /**
   * REACTIVACIÓN por el eje FLEET (doc/ITV regularizado): reincorpora HOLDS-AWARE (solo si no sobrevive otro
   * hold). Misma resolución de clave dual. La carrera con el consumer de identity la acota el TTL de auto-cura.
   */
  private async onFleetDriverReactivated(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['fleet.driver_reactivated'].parse(env.payload);
    await this.suspensionService.onFleetReactivated({ driverId: p.driverId, userId: p.userId });
  }

  private async onRating(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['rating.created'].parse(env.payload);
    await this.projection.onRatingCreated(p.driverId, p.stars);
  }

  private async onDriverFlagged(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.flagged'].parse(env.payload);
    await this.projection.onDriverFlagged(p.driverId, p.rollingAvg);
  }

  private async onTripCompleted(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.completed'].parse(env.payload);
    // HARDENING (incidente dev 2026-06): `tripId` es `z.string()` en @veo/events (NO `.uuid()` —
    // endurecer el schema compartido afecta a TODOS los producers/consumers). Pero la columna es
    // `@db.Uuid`: un tripId malformado → P2023 → relanzar → crash-loop. Guardamos el borde: si el
    // id no es UUID, es veneno → log ERROR + RETURN (saltar, el offset avanza). Sin esto se bloquea
    // la partición y los viajes nuevos no abren board.
    if (!isUuid(p.tripId)) {
      this.logger.error(
        `POISON trip.completed: tripId no-UUID "${String(p.tripId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'trip.completed', result: BusinessEventResult.REJECTED });
      return;
    }
    try {
      const driverId = await this.dispatch.driverForTrip(p.tripId);
      if (!driverId) return;
      await this.projection.onTripCompleted(driverId, new Date());
      await this.dispatch.releaseDriver(driverId);
    } catch (err) {
      // Red de seguridad: cualquier OTRO error permanente de datos (P2009/P2000…) → saltar. Lo
      // transitorio (DB caída, deadlock, timeout) se RELANZA para que Kafka reintente.
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON trip.completed: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'trip.completed', result: BusinessEventResult.REJECTED });
        return;
      }
      throw err;
    }
  }

  private async onTripCancelled(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.cancelled'].parse(env.payload);
    // BF · el trip murió ⇒ el board muere SIEMPRE, sin importar quién canceló. Sin esto, la cancelación
    // del PASAJERO dejaba el board OPEN en Redis (board fantasma recibiendo ofertas para un viaje muerto),
    // y en la carrera reassign‖cancel el reopen del board sobrevivía al trip CANCELLED. Idempotente (CAS
    // OPEN→CANCELLED): si el board no existe o ya cerró (matched/expired), es no-op.
    // HARDENING: cancelBoard opera sobre Redis (key string, tolera cualquier id) pero driverForTrip
    // toca la columna `@db.Uuid`. Guardamos el borde ANTES de tocar Prisma: un tripId no-UUID es
    // veneno → log ERROR + saltar (cancelBoard sobre un id basura es no-op inofensivo igualmente).
    if (!isUuid(p.tripId)) {
      this.logger.error(
        `POISON trip.cancelled: tripId no-UUID "${String(p.tripId)}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'trip.cancelled', result: BusinessEventResult.REJECTED });
      return;
    }
    // CAPA 2 (anti-IDOR): cancelBoard ancla el ownership del board al pasajero SOLICITANTE en el camino
    // HTTP. ESTE camino NO es el cancel del pasajero: es la AUTORIDAD DEL VIAJE (trip.cancelled, evento de
    // dominio CONFIABLE de trip-service) — el trip YA murió por otra vía y el board debe morir SIEMPRE,
    // sin importar quién era el dueño (emitClosure=false: no re-emite cierre, anti-bucle). Un atacante no
    // puede forjar un evento Kafka interno, así que el guard de ownership NO aplica acá: pasamos
    // `system:true` para saltarlo explícitamente (camino de sistema, no de usuario final).
    await this.offerBoard.cancelBoard(p.tripId, { system: true });
    // FIXED: el viaje murió ⇒ cerrar la sesión de matching secuencial (CANCELLED) para que el advance/
    // reconciler no sigan ofertando a un viaje cancelado. Idempotente (CAS); no-op si no había sesión (PUJA).
    await this.matching.cancelSession(p.tripId);
    if (p.by !== 'DRIVER') {
      return;
    }
    // driverId del PAYLOAD ENRIQUECIDO (trip.driverId, el conductor asignado — perfil), NO driverForTrip:
    // `trip.cancelled by=DRIVER` es PRE-accept (el conductor está ASSIGNED, NO ACCEPTED), y driverForTrip busca
    // el match con outcome=ACCEPTED → devolvería null/incorrecto y la cancelación pre-accept NO se contaría.
    // trip-service ya enriquece el payload con el driverId (trips.service.ts). Coherente con onReassigning, que
    // también cuenta con su p.driverId del payload. Guard `if (p.driverId)`: ausente si no había conductor.
    if (!p.driverId) {
      return;
    }
    try {
      // Ventana ROLLING 24h (auto-suspensión por exceso) + contador LIFELONG (tasa de cancelación BR-T06, NUNCA
      // se poda): AMBOS en registerCancellationInWindow, idempotentes por el natural key (driverId, tripId) → una
      // re-entrega Kafka no infla ni la ventana ni la tasa. Emite `driver.excessive_cancellations` UNA vez al
      // cruzar el umbral. `occurredAt` = momento REAL de la cancelación (del envelope), no el de consumo.
      await this.projection.registerCancellationInWindow(
        p.driverId,
        p.tripId,
        new Date(env.occurredAt),
      );
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON trip.cancelled: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'trip.cancelled', result: BusinessEventResult.REJECTED });
        return;
      }
      throw err;
    }
  }
}
