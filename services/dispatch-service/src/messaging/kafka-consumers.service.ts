/**
 * Consumidores Kafka de dispatch-service. Valida cada payload contra @veo/events y enruta:
 *  - trip.requested          → registra demanda surge + lanza el matching (BR-T06).
 *  - driver.location_updated → actualiza el hot index (ubicación + celda H3).
 *  - panic.triggered         → excluye al conductor del viaje en pánico (prioridad de pánico).
 *  - rating.created          → proyección de rating del conductor.
 *  - driver.flagged          → proyección de rating (valor impuesto).
 *  - trip.completed          → proyección (último viaje) + reincorpora al conductor al pool.
 *  - trip.cancelled          → proyección de cancelación (solo si la cancela el conductor).
 *
 * El matching es de larga duración (ofertas secuenciales con timeout): se lanza sin bloquear el
 * commit del consumidor; sus efectos durables (matches, eventos) se persisten igual.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  EVENT_SCHEMAS,
  isPermanentDataError,
  isUuid,
  type EventEnvelope,
} from '@veo/events';
import { domainEventsTotal } from '@veo/observability';
import { DispatchService } from '../dispatch/dispatch.service';
import { MatchingService } from '../dispatch/matching.service';
import { SurgeService } from '../dispatch/surge.service';
import { DriverProjectionService } from '../dispatch/driver-projection.service';
import { OfferBoardService } from '../dispatch/offer-board.service';
import { HeatmapService } from '../heatmap/heatmap.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class KafkaConsumersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumersService.name);
  private consumer?: KafkaEventConsumer;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly dispatch: DispatchService,
    private readonly matching: MatchingService,
    private readonly surge: SurgeService,
    private readonly projection: DriverProjectionService,
    private readonly offerBoard: OfferBoardService,
    private readonly heatmap: HeatmapService,
  ) {}

  async onModuleInit(): Promise<void> {
    const kafka = createKafka({
      clientId: 'dispatch-service',
      brokers: this.config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'dispatch-service',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'dispatch-service');

    this.consumer
      .on('trip.requested', (env) => this.onTripRequested(env))
      // PUJA (ADR 010 · Lote B): el board consume el bid del pasajero y la re-apertura tras cancel.
      // Lote C: trip-service emitirá `trip.bid_posted`; hoy el board lo consume en aislamiento, sin
      // tocar el camino legacy `trip.requested`→matching auto-secuencial.
      .on('trip.bid_posted', (env) => this.onBidPosted(env))
      .on('trip.reassigning', (env) => this.onReassigning(env))
      .on('driver.location_updated', (env) => this.onDriverLocation(env))
      .on('panic.triggered', (env) => this.onPanic(env))
      .on('rating.created', (env) => this.onRating(env))
      .on('driver.flagged', (env) => this.onDriverFlagged(env))
      .on('trip.completed', (env) => this.onTripCompleted(env))
      .on('trip.cancelled', (env) => this.onTripCancelled(env));

    await this.consumer.start();
    this.logger.log('consumidores Kafka iniciados');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  private async onTripRequested(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.requested'].parse(env.payload);
    domainEventsTotal.inc({ event: 'trip.requested', result: 'consumed' });
    await this.surge.recordDemand(p.origin);
    // Ola 2C: alimenta el mapa de calor de demanda por celda H3 (ventana deslizante en Redis).
    await this.heatmap.recordDemand(p.origin);
    // Ola 2B: el matching filtra candidatos por tipo de vehículo (MOTO solo a conductores MOTO).
    // Default CAR para eventos previos a Ola 2B (compat).
    const requiredVehicleType = p.vehicleType ?? 'CAR';
    // Lanza el matching sin bloquear el commit del consumidor (flujo de oferta de larga duración).
    void this.matching
      .handleTripRequested({ tripId: p.tripId, origin: p.origin, requiredVehicleType })
      .catch((err) => this.logger.error(`matching falló para trip ${p.tripId}: ${String(err)}`));
  }

  /**
   * PUJA (ADR 010 §3.2): el pasajero posteó un bid → abre el OfferBoard y difunde a elegibles.
   * Idempotente por tripId (re-abre el mismo board). No bloquea el commit del consumidor.
   */
  private async onBidPosted(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.bid_posted'].parse(env.payload);
    domainEventsTotal.inc({ event: 'trip.bid_posted', result: 'consumed' });
    await this.offerBoard.openBoard({
      tripId: p.tripId,
      passengerId: p.passengerId,
      bidCents: p.bidCents,
      vehicleType: p.vehicleType,
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
   */
  private async onReassigning(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.reassigning'].parse(env.payload);
    domainEventsTotal.inc({ event: 'trip.reassigning', result: 'consumed' });
    // Libera al conductor que canceló (vuelve a ser elegible para el matching).
    if (p.driverId) await this.dispatch.releaseDriver(p.driverId);
    await this.offerBoard.reopenBoard({
      tripId: p.tripId,
      driverId: p.driverId,
      passengerId: p.passengerId,
      vehicleType: p.vehicleType,
      origin: p.origin,
      bidCents: p.bidCents,
      // H13 — el seq del NUEVO ciclo de la reasignación: el board re-abierto lo estampa en offer_accepted.
      negotiationSeq: p.negotiationSeq,
    });
  }

  private async onDriverLocation(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.location_updated'].parse(env.payload);
    // Ola 2B: el tipo de vehículo activo (default CAR) se proyecta en el hot index para el filtrado.
    await this.dispatch.ingestLocation(p.driverId, p.point, p.vehicleType ?? 'CAR');
    domainEventsTotal.inc({ event: 'driver.location_updated', result: 'consumed' });
  }

  private async onPanic(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['panic.triggered'].parse(env.payload);
    // HARDENING: `tripId` toca la columna `@db.Uuid` (excludeDriverForPanic → findFirst). Un id
    // malformado envenenaría el topic `panic` (crash-loop). Pánico es safety-critical: si el id es
    // veneno, logueamos en ERROR (alta visibilidad para operación) y saltamos — NO podemos bloquear
    // la partición de pánico de todos los demás viajes por un evento corrupto.
    if (!isUuid(p.tripId)) {
      this.logger.error(
        `POISON panic.triggered: tripId no-UUID "${p.tripId}" (panicId=${p.panicId}, eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'panic.triggered', result: 'poison' });
      return;
    }
    try {
      const driverId = await this.dispatch.excludeDriverForPanic(p.tripId);
      if (driverId) this.logger.warn(`pánico en trip ${p.tripId}: conductor ${driverId} excluido del pool`);
      domainEventsTotal.inc({ event: 'panic.triggered', result: 'consumed' });
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON panic.triggered: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'panic.triggered', result: 'poison' });
        return;
      }
      throw err;
    }
  }

  private async onRating(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['rating.created'].parse(env.payload);
    await this.projection.onRatingCreated(p.driverId, p.stars);
    domainEventsTotal.inc({ event: 'rating.created', result: 'consumed' });
  }

  private async onDriverFlagged(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.flagged'].parse(env.payload);
    await this.projection.onDriverFlagged(p.driverId, p.rollingAvg);
    domainEventsTotal.inc({ event: 'driver.flagged', result: 'consumed' });
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
        `POISON trip.completed: tripId no-UUID "${p.tripId}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'trip.completed', result: 'poison' });
      return;
    }
    try {
      const driverId = await this.dispatch.driverForTrip(p.tripId);
      if (!driverId) return;
      await this.projection.onTripCompleted(driverId, new Date());
      await this.dispatch.releaseDriver(driverId);
      domainEventsTotal.inc({ event: 'trip.completed', result: 'consumed' });
    } catch (err) {
      // Red de seguridad: cualquier OTRO error permanente de datos (P2009/P2000…) → saltar. Lo
      // transitorio (DB caída, deadlock, timeout) se RELANZA para que Kafka reintente.
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON trip.completed: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'trip.completed', result: 'poison' });
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
        `POISON trip.cancelled: tripId no-UUID "${p.tripId}" (eventId=${env.eventId}); descartado sin reintento`,
      );
      domainEventsTotal.inc({ event: 'trip.cancelled', result: 'poison' });
      return;
    }
    await this.offerBoard.cancelBoard(p.tripId);
    if (p.by !== 'DRIVER') {
      domainEventsTotal.inc({ event: 'trip.cancelled', result: 'consumed' });
      return;
    }
    try {
      const driverId = await this.dispatch.driverForTrip(p.tripId);
      if (!driverId) return;
      await this.projection.onTripCancelledByDriver(driverId);
      domainEventsTotal.inc({ event: 'trip.cancelled', result: 'consumed' });
    } catch (err) {
      if (isPermanentDataError(err)) {
        this.logger.error(
          `POISON trip.cancelled: error permanente de datos para trip ${p.tripId} (eventId=${env.eventId}); descartado: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: 'trip.cancelled', result: 'poison' });
        return;
      }
      throw err;
    }
  }
}
