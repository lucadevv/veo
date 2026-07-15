/**
 * Consumidores Kafka de dispatch-service. Valida cada payload contra @veo/events y enruta:
 *  - trip.requested          → registra demanda surge + lanza el matching (BR-T06).
 *  - driver.location_updated → actualiza el hot index (ubicación + celda H3).
 *  - panic.triggered         → excluye al conductor del viaje en pánico (prioridad de pánico).
 *  - rating.created          → proyección de rating del conductor.
 *  - driver.flagged          → proyección de rating (valor impuesto).
 *  - trip.completed          → proyección (último viaje) + reincorpora al conductor al pool + suelta claim (A2).
 *  - trip.cancelled          → mata el board + libera al conductor asignado del pool (B2) + cuenta la
 *                              cancelación si la hizo el conductor PRE-accept.
 *  - trip.expired            → (B2) libera al conductor asignado del pool (watchdog PRE-recojo).
 *  - trip.failed             → (B2) libera al conductor asignado del pool (watchdog EN-curso abandonado).
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
import { isPermanentGrpcError } from '@veo/rpc';
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
      // ESCALA (Lote 3 · firehose GPS): procesa varias particiones EN PARALELO. `driver-location` está keyed
      // por driverId → un mismo conductor cae SIEMPRE en la misma partición y kafkajs la procesa SERIAL (el
      // RMW per-driver del hot-index queda intacto); solo corren en paralelo conductores de particiones
      // DISTINTAS. Los demás topics de este group también son per-key (per-aggregate) → su orden se preserva.
      partitionsConsumedConcurrently: config.getOrThrow<number>('KAFKA_CONSUMER_CONCURRENCY'),
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
      // ADR-022 §P-A · BLOQUEO POR DEUDA (tope de comisiones CASH): payment-service emite `driver.debt_exceeded`/
      // `driver.debt_cleared` (topic 'driver', ya suscrito). REUSAN el MISMO riel de exclusión del pool que
      // driver.suspended/reactivated (DriverSuspensionService.onSuspended/onReactivated) — NO es un gate nuevo, es
      // el mismo con otro disparador. El bloqueo NO reusa `driver.suspended` a propósito: ese evento revoca la
      // sesión (driver-bff cierra el socket) y mataría el viaje EN CURSO (bloqueo tipo A = el viaje se termina normal).
      'driver.debt_exceeded': (env) => this.onDriverDebtExceeded(env),
      'driver.debt_cleared': (env) => this.onDriverDebtCleared(env),
      // Fase B (ADR-021 · B-react) — el conductor pasó a OFFLINE (fin de turno o caída de socket): retira sus
      // ofertas OPEN de los boards (card muere reactiva en el board del pasajero) + lo EVICTA del pool. La
      // REASIGNACIÓN de su viaje pre-recojo la hace trip-service (consume el MISMO evento → trip.reassigning →
      // este group re-abre el board por onReassigning). Mismo topic 'driver' que suspended/reactivated.
      'driver.went_offline': (env) => this.onDriverWentOffline(env),
      // SUSPENSIÓN por el eje FLEET (doc/ITV vencido): MISMA exclusión del pool que el eje disciplinario.
      // El sujeto llega por clave DUAL (driverId de perfil XOR userId=User.id de la vía ITV) → el service
      // resuelve a Driver.id. Cierra la under-exclusion del eje doc/ITV (Lote 2b). Suscribe el topic `fleet`.
      'fleet.driver_suspended': (env) => this.onFleetDriverSuspended(env),
      'fleet.driver_reactivated': (env) => this.onFleetDriverReactivated(env),
      'rating.created': (env) => this.onRating(env),
      'driver.flagged': (env) => this.onDriverFlagged(env),
      'trip.completed': (env) => this.onTripCompleted(env),
      'trip.cancelled': (env) => this.onTripCancelled(env),
      // B2 (ADR-021 Fase A) — terminales del watchdog: liberan al conductor asignado del pool. Ambos caen en
      // el topic 'trip' (topicForEvent) que este group YA suscribe por trip.completed/cancelled → registrar
      // el handler basta; no hace falta declarar un topic nuevo (el bootstrap dedup-a el topic al suscribir).
      'trip.expired': (env) => this.onTripExpired(env),
      'trip.failed': (env) => this.onTripFailed(env),
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
      // Destino + distancia/duración del viaje: el board los guarda para que el conductor pinte pickup→destino
      // + distancia en la tarjeta de puja (el destino se engrosa a ~111m al exponerse a los no asignados).
      destination: p.destination,
      distanceMeters: p.distanceMeters,
      durationSeconds: p.durationSeconds,
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
    // El OfferBoard es dominio PUJA: en FIXED el re-match lo re-arranca el trip.requested que la estrategia
    // emite junto a este evento — re-abrir un board acá sería DOBLE oferta al conductor (board fantasma).
    // La liberación (arriba) y el conteo (abajo) sí son transversales al modo. Ausente ⇒ PUJA (compat N-2).
    if (p.dispatchMode !== 'FIXED') {
      await this.offerBoard.reopenBoard({
        tripId: p.tripId,
        driverId: p.driverId,
        passengerId: p.passengerId,
        vehicleType: p.vehicleType,
        // B5-3 — re-persiste el tier en el board re-abierto para enforcar el TIER en el re-match.
        category: p.category,
        origin: p.origin,
        // Destino + distancia/duración: el board re-abierto los conserva para que el conductor del re-match
        // vea pickup→destino + distancia igual que la puja original (trip.reassigning ya los transporta).
        destination: p.destination,
        distanceMeters: p.distanceMeters,
        durationSeconds: p.durationSeconds,
        bidCents: p.bidCents,
        // H13 — el seq del NUEVO ciclo de la reasignación: el board re-abierto lo estampa en offer_accepted.
        negotiationSeq: p.negotiationSeq,
      });
    }
    // Recién AHORA, con el board ya re-abierto, suma esta cancelación POST-accept a la MISMA ventana rolling 24h
    // de la auto-suspensión. El guard `p.driverId` cubre el borde del emisor (manda '' si no había conductor
    // asignado — imposible POST-accept, pero defensa en profundidad: sin id de perfil no se puede atribuir).
    // `tripId` es UUID (toca @db.Uuid en driver_cancellation_events); el schema lo deja como z.string()
    // compartido, así que guardamos el borde igual que onTripCancelled — un id no-UUID es veneno → log ERROR +
    // saltar (el board ya quedó re-abierto).
    if (p.driverId) {
      if (this.isPoisonNonUuid('trip.reassigning', env.eventId, p.tripId)) return;
      // Error permanente de datos → saltar el conteo (el reopen del board ya ocurrió arriba, el pasajero no
      // queda abandonado). Lo transitorio se relanza para que Kafka reintente AMBOS (reopen idempotente).
      const driverId = p.driverId;
      await this.withPoisonGuard(
        'trip.reassigning',
        env.eventId,
        isPermanentDataError,
        () =>
          this.projection.registerCancellationInWindow(
            driverId,
            p.tripId,
            new Date(env.occurredAt),
          ),
        `driver=${driverId}, trip=${p.tripId}`,
      );
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
    // HARDENING: `tripId` toca la columna `@db.Uuid` (excludeDriverForPanic → findFirst). Un id malformado
    // envenenaría el topic `panic` (crash-loop). Pánico es safety-critical: si el id es veneno, log ERROR +
    // saltar — NO podemos bloquear la partición de pánico de todos los demás viajes por un evento corrupto.
    if (this.isPoisonNonUuid('panic.triggered', env.eventId, p.tripId, `panicId=${p.panicId}`))
      return;
    await this.withPoisonGuard(
      'panic.triggered',
      env.eventId,
      isPermanentDataError,
      async () => {
        const driverId = await this.dispatch.excludeDriverForPanic(p.tripId);
        if (driverId)
          this.logger.warn(`pánico en trip ${p.tripId}: conductor ${driverId} excluido del pool`);
      },
      `trip=${p.tripId}, panicId=${p.panicId}`,
    );
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
   * reincorpora al pool SOLO si el conductor quedó sin holds. Un error gRPC TRANSITORIO (identity caído/lento)
   * relanza ⇒ kafkajs re-entrega; uno PERMANENTE (config/contrato) se SALTA (poison guard) en vez de
   * crash-loopear la partición. El TTL de auto-cura + el accept-gate son el backstop del evento descartado.
   */
  private async onDriverReactivated(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.reactivated'].parse(env.payload);
    await this.withPoisonGuard('driver.reactivated', env.eventId, isPermanentGrpcError, () =>
      this.suspensionService.onReactivated(p.driverId),
    );
  }

  /**
   * ADR-022 §P-A · BLOQUEO POR DEUDA: el conductor cruzó el tope de comisiones CASH → sale del pool de matching
   * (misma exclusión que una suspensión: identity ya le seteó `suspendedAt` con el hold DEBT_BLOCKED, así que el
   * accept/oferta lo frena fail-closed; esto cierra la MEMBRESÍA para no ofertarle de gusto). `driverId` viaja como
   * member de un SET de Redis (no toca `@db.Uuid`) → sin veneno de tipo; SADD idempotente. Un fallo de Redis es
   * transitorio → relanza → kafkajs reintenta. El viaje EN CURSO NO se toca (bloqueo tipo A).
   */
  private async onDriverDebtExceeded(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.debt_exceeded'].parse(env.payload);
    await this.suspensionService.onSuspended(p.driverId);
  }

  /**
   * ADR-022 §P-A · DESBLOQUEO POR DEUDA: el conductor saldó → reincorpora al pool HOLDS-AWARE (re-valida
   * `suspendedAt` en identity: si quedó sin holds, limpia la exclusión; si sigue suspendido por otra causa,
   * permanece excluido). Mismo riel que `driver.reactivated`. Error gRPC transitorio relanza (kafkajs reintenta);
   * permanente → poison guard (no crash-loop). El TTL de auto-cura respalda la carrera identity↔dispatch.
   */
  private async onDriverDebtCleared(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.debt_cleared'].parse(env.payload);
    await this.withPoisonGuard('driver.debt_cleared', env.eventId, isPermanentGrpcError, () =>
      this.suspensionService.onReactivated(p.driverId),
    );
  }

  /**
   * Guarda de POISON para un handler cuya dependencia puede fallar PERMANENTE (config/contrato/datos) o
   * TRANSITORIO (red/carga/DB caída). Un error PERMANENTE (según `isPermanent`) se DESCARTA (log ERROR +
   * métrica REJECTED + el offset avanza) en vez de relanzar → evita el crash-loop / head-of-line block de la
   * partición; lo TRANSITORIO se RELANZA para que kafkajs reintente. `isPermanent` es la clasificación del
   * carril: `isPermanentGrpcError` (gRPC) o `isPermanentDataError` (Prisma). Backstop del evento descartado:
   * depende del handler (TTL de auto-cura + accept-gate en suspensión; idempotencia del board en cancelaciones).
   * `detail` (opcional) suma contexto forense directo al log (ej. `trip=...`) — el eventId siempre recupera
   * el payload completo, pero en paths sensibles conviene tenerlo a la vista sin un nivel de indirección.
   */
  private async withPoisonGuard(
    eventType: string,
    eventId: string,
    isPermanent: (err: unknown) => boolean,
    fn: () => Promise<void>,
    detail?: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (isPermanent(err)) {
        this.logger.error(
          `POISON ${eventType}: error permanente (${this.poisonCtx(eventId, detail)}); descartado sin reintento: ${String(err)}`,
        );
        domainEventsTotal.inc({ event: eventType, result: BusinessEventResult.REJECTED });
        return;
      }
      throw err;
    }
  }

  /**
   * Pre-check de POISON para un id que toca una columna `@db.Uuid`: un id malformado crashearía la query
   * (Prisma P2023) → relanzar → crash-loop de la partición. Si el id NO es UUID, lo loguea (ERROR + métrica
   * REJECTED) y devuelve `true` → el caller DEBE `return` para saltar el evento (el offset avanza). UUID
   * válido ⇒ `false`. `detail` opcional = contexto forense extra (ej. `panicId=...` en el path de pánico).
   */
  private isPoisonNonUuid(
    eventType: string,
    eventId: string,
    id: string,
    detail?: string,
  ): boolean {
    if (isUuid(id)) return false;
    this.logger.error(
      `POISON ${eventType}: id no-UUID "${String(id)}" (${this.poisonCtx(eventId, detail)}); descartado sin reintento`,
    );
    domainEventsTotal.inc({ event: eventType, result: BusinessEventResult.REJECTED });
    return true;
  }

  /** Contexto de un log POISON: `eventId=...` + el `detail` forense del handler (panicId/trip/driver) si lo hay. */
  private poisonCtx(eventId: string, detail?: string): string {
    return detail ? `eventId=${eventId}, ${detail}` : `eventId=${eventId}`;
  }

  /**
   * SUSPENSIÓN por el eje FLEET (doc/ITV): el conductor sale del pool. El sujeto viaja por clave dual
   * (XOR driverId|userId, ver `fleetDriverSuspended`); el service resuelve a Driver.id (User.id → perfil
   * por gRPC en la vía ITV). Error gRPC transitorio ⇒ relanza (kafkajs reintenta); permanente ⇒ poison guard.
   */
  private async onFleetDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['fleet.driver_suspended'].parse(env.payload);
    await this.withPoisonGuard('fleet.driver_suspended', env.eventId, isPermanentGrpcError, () =>
      this.suspensionService.onFleetSuspended({ driverId: p.driverId, userId: p.userId }),
    );
  }

  /**
   * REACTIVACIÓN por el eje FLEET (doc/ITV regularizado): reincorpora HOLDS-AWARE (solo si no sobrevive otro
   * hold). Misma resolución de clave dual. La carrera con el consumer de identity la acota el TTL de auto-cura.
   */
  private async onFleetDriverReactivated(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['fleet.driver_reactivated'].parse(env.payload);
    await this.withPoisonGuard('fleet.driver_reactivated', env.eventId, isPermanentGrpcError, () =>
      this.suspensionService.onFleetReactivated({ driverId: p.driverId, userId: p.userId }),
    );
  }

  /**
   * Fase B (ADR-021 · B-react) — `driver.went_offline`: (1) RETIRA las ofertas OPEN del conductor de los
   * boards (STALE + offer_withdrawn → la card muere reactiva en el board del pasajero) y (2) lo EVICTA del
   * pool (hot-index remove: fuera del matching estando offline). La REASIGNACIÓN del viaje pre-recojo NO se
   * hace acá: trip-service consume el mismo evento y emite `trip.reassigning`, que ESTE group ya reabre por
   * `onReassigning` (release + reopen). Todo sobre Redis/outbox (keys string, `driverId` no toca @db.Uuid) →
   * SIN poison de tipo; idempotente + fail-safe (offline de un conductor sin ofertas/loc es no-op). Un error
   * transitorio de Redis relanza (kafkajs reintenta; ambas ops son idempotentes).
   */
  private async onDriverWentOffline(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['driver.went_offline'].parse(env.payload);
    await this.offerBoard.withdrawDriverOffers(p.driverId);
    await this.dispatch.evictDriver(p.driverId);
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
    if (this.isPoisonNonUuid('trip.completed', env.eventId, p.tripId)) return;
    // Red de seguridad: un error permanente de datos (P2009/P2000…) → saltar; lo transitorio (DB caída,
    // deadlock, timeout) se RELANZA para que Kafka reintente.
    await this.withPoisonGuard(
      'trip.completed',
      env.eventId,
      isPermanentDataError,
      async () => {
        const driverId = await this.dispatch.driverForTrip(p.tripId);
        if (!driverId) return;
        await this.projection.onTripCompleted(driverId, new Date());
        await this.dispatch.releaseDriver(driverId);
      },
      `trip=${p.tripId}`,
    );
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
    if (this.isPoisonNonUuid('trip.cancelled', env.eventId, p.tripId)) return;
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
    // B2 (ADR-021 Fase A) — LIBERA al conductor asignado del pool. Hasta hoy onTripCancelled NO llamaba a
    // releaseDriver → un conductor con match ACCEPTED (cancel POST-accept del pasajero/sistema) quedaba
    // markBusy + reclamado hasta el TTL (2h), fuera del pool. Se resuelve por driverForTrip (match ACCEPTED,
    // igual que onTripCompleted) y se suelta (markAvailable + releaseClaim, vía releaseDriver). Fail-safe: un
    // cancel PRE-accept (by=DRIVER, ASSIGNED sin ACCEPTED) → driverForTrip null → no-op. Va ANTES del conteo
    // (seguridad primero: liberar el pool no debe quedar gateado por la analítica de la cancelación).
    await this.releaseAssignedDriver('trip.cancelled', env.eventId, p.tripId);
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
    // Ventana ROLLING 24h (auto-suspensión por exceso) + contador LIFELONG (tasa de cancelación BR-T06, NUNCA
    // se poda): AMBOS en registerCancellationInWindow, idempotentes por el natural key (driverId, tripId) → una
    // re-entrega Kafka no infla ni la ventana ni la tasa. Emite `driver.excessive_cancellations` UNA vez al
    // cruzar el umbral. `occurredAt` = momento REAL de la cancelación (del envelope), no el de consumo.
    const driverId = p.driverId;
    await this.withPoisonGuard(
      'trip.cancelled',
      env.eventId,
      isPermanentDataError,
      () =>
        this.projection.registerCancellationInWindow(driverId, p.tripId, new Date(env.occurredAt)),
      `driver=${driverId}, trip=${p.tripId}`,
    );
  }

  /**
   * B2 (ADR-021 Fase A) — un viaje PRE-RECOJO se estancó y el watchdog lo llevó a EXPIRED. Hasta hoy
   * trip.expired NO estaba en este consumer: un conductor que había aceptado (match ACCEPTED) y luego el
   * viaje expiró quedaba markBusy + reclamado hasta el TTL (2h), fuera del pool. Lo liberamos.
   */
  private async onTripExpired(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.expired'].parse(env.payload);
    if (this.isPoisonNonUuid('trip.expired', env.eventId, p.tripId)) return;
    // GAP #2 (2026-07-15) — el viaje murió por watchdog: si un board PUJA seguía OPEN con ofertas PENDING
    // (carrera con el sweep del board), cerralo SIEMPRE y notificá a los bidders. cancelBoard(system) hace
    // cancelIfOpen + clearOffers + `offer_withdrawn(cancelled)` por conductor (GAP #1) → sus cards mueren
    // reactivas en vez de esperar el poll de 12s. Espeja onTripCancelled. Idempotente (no-op si ya cerró).
    await this.offerBoard.cancelBoard(p.tripId, { system: true });
    await this.releaseAssignedDriver('trip.expired', env.eventId, p.tripId);
  }

  /**
   * B2 (ADR-021 Fase A) — un viaje EN CURSO quedó abandonado y el watchdog lo llevó a FAILED. Mismo release
   * del conductor asignado (markAvailable + releaseClaim) para que no quede fuera del pool hasta el TTL.
   */
  private async onTripFailed(env: EventEnvelope<unknown>): Promise<void> {
    const p = EVENT_SCHEMAS['trip.failed'].parse(env.payload);
    if (this.isPoisonNonUuid('trip.failed', env.eventId, p.tripId)) return;
    await this.releaseAssignedDriver('trip.failed', env.eventId, p.tripId);
  }

  /**
   * B2 (ADR-021 Fase A) — helper compartido de los TERMINALES (cancelled/expired/failed): resuelve el
   * conductor ACCEPTED del viaje y lo libera del pool (markAvailable + releaseClaim per-driver, vía
   * dispatch.releaseDriver). Envuelto en poison-guard porque driverForTrip toca una columna `@db.Uuid`: un
   * error PERMANENTE de datos se descarta (no crash-loop de la partición), uno TRANSITORIO se relanza
   * (kafkajs reintenta; el release es idempotente). Fail-safe: viaje SIN match ACCEPTED → driverForTrip
   * null → no-op (un cancel/expire PRE-accept no tiene conductor markBusy que liberar). El caller DEBE
   * haber validado ya que `tripId` es UUID (isPoisonNonUuid) antes de invocar.
   */
  private async releaseAssignedDriver(
    eventType: string,
    eventId: string,
    tripId: string,
  ): Promise<void> {
    await this.withPoisonGuard(
      eventType,
      eventId,
      isPermanentDataError,
      async () => {
        const driverId = await this.dispatch.driverForTrip(tripId);
        if (driverId) await this.dispatch.releaseDriver(driverId);
      },
      `trip=${tripId} (release)`,
    );
  }
}
