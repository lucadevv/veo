/**
 * Consumidor Kafka que alimenta el seguimiento en vivo del namespace /family.
 * Suscrito a los topics `trip`, `dispatch`, `panic` y `driver-location` (el firehose `driver.location_updated`,
 * aislado en su propio topic por topicForEvent — NO el topic 'driver' de ciclo de vida).
 * Valida cada payload con los schemas de @veo/events, mantiene el mapa driver→trip y el último
 * estado/ubicación, y emite a las salas de viajes con tokens vivos.
 *
 * El BOOTSTRAP (createKafka + consumer del group + registro) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest). Acá se conserva el ARRANQUE NO BLOQUEANTE del BFF:
 * si Kafka aún no responde, el proceso sigue vivo y se registra el error.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  dispatchMatchFound,
  dispatchOfferMade,
  dispatchOfferWithdrawn,
  driverLocationUpdated,
  panicResolved,
  panicTriggered,
  tripAccepted,
  tripArrived,
  tripArriving,
  tripAssigned,
  tripBidPosted,
  tripCancelled,
  tripCompleted,
  tripDestinationChanged,
  tripExpired,
  tripFailed,
  tripReassigning,
  tripRequested,
  tripStarted,
  chatMessageSent,
  tripWaypointAccepted,
  tripWaypointRejected,
  tripWaypointExpired,
  type EventEnvelope,
  type EventHandler,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { Inject } from '@nestjs/common';
import { createLogger, type Logger } from '@veo/observability';
import { PanicStatus } from '@veo/shared-types';
import {
  isOnboard,
  WaypointProposalStatus,
  type ChatMessage,
  type GeoPoint,
  type TripStatus,
} from '@veo/api-client';
import type { MapsClient } from '@veo/maps';
import { MAPS } from '../infra/downstream.tokens';
import { FamilyGateway } from './family.gateway';
import { PassengerGateway } from './passenger.gateway';
import { RealtimeStateService } from './realtime-state.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este BFF. */
const KAFKA_CLIENT_ID = 'public-bff';

/** Group del tiempo real de public-bff. */
const REALTIME_GROUP_ID = 'public-bff-realtime';

/** Cadencia mínima del recompute de ETA por viaje (misma que el poll de ruta del conductor). */
const ETA_REFRESH_MS = 15_000;

/** Fases con ETA vivo: pre-recojo (→ recojo) y onboard (→ destino). Fuera de ellas, no se recomputa. */
const ETA_PHASES: ReadonlySet<TripStatus> = new Set([
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
]);

@Injectable()
export class RealtimeConsumerService extends KafkaConsumerBootstrap {
  private readonly log: Logger = createLogger('public-bff:realtime');
  /** Último recompute de ETA por viaje (throttle in-memory; se poda junto al estado del viaje). */
  private readonly lastEtaComputeAt = new Map<string, number>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly gateway: FamilyGateway,
    private readonly passenger: PassengerGateway,
    private readonly state: RealtimeStateService,
    @Inject(MAPS) private readonly maps: MapsClient,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config
        .getOrThrow<string>('KAFKA_BROKERS')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean),
      groupId: REALTIME_GROUP_ID,
    });
  }

  override onModuleInit(): Promise<void> {
    // No bloquea el arranque: si Kafka aún no responde, el proceso sigue y se registra el error.
    void super.onModuleInit().catch((err: unknown) => {
      this.log.error({ err }, 'el consumidor Kafka de tiempo real no inició');
    });
    return Promise.resolve();
  }

  protected override subscriptionLog(): string {
    return 'consumidor de tiempo real iniciado';
  }

  /** TODOS los eventos del group, en un solo record (cada uno se suscribe a su topic). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'trip.requested': (env) => this.onTripRequested(env),
      // RC5 (ADR-022) · el destino se reescribió pre-start: el ETA fresco debe apuntar al NUEVO destino.
      'trip.destination_changed': (env) => this.onDestinationChanged(env),
      // ADR-020 Lote 1 · la puja (re)abrió (PUJA inicial o re-bid). Antes ORPHAN (ningún BFF lo consumía)
      // → el pasajero no recibía push al re-pujar y el timer/fase dependían 100% del poll de 5s. El topic
      // 'trip' YA está suscrito (registrar el handler basta; kafka.ts añade el topic vía topicForEvent).
      'trip.bid_posted': (env) => this.onBidPosted(env),
      'trip.assigned': (env) => this.onTripAssigned(env),
      'trip.accepted': (env) => this.onTripAccepted(env),
      'trip.arriving': (env) => this.onTripArriving(env),
      'trip.arrived': (env) => this.onTripStatus(env, tripArrived, 'ARRIVED'),
      'trip.started': (env) => this.onTripStatus(env, tripStarted, 'IN_PROGRESS'),
      'trip.completed': (env) => this.onTripEnded(env, tripCompleted, 'COMPLETED'),
      'trip.cancelled': (env) => this.onTripEnded(env, tripCancelled, 'CANCELLED'),
      // Antes NO se consumían: el pasajero quedaba colgado en "Buscando conductor" para siempre cuando
      // la puja expiraba, el viaje fallaba (watchdog) o el conductor cancelaba (reasignación).
      'trip.expired': (env) => this.onTripExpired(env),
      'trip.failed': (env) => this.onTripFailed(env),
      'trip.reassigning': (env) => this.onTripReassigning(env),
      'dispatch.match_found': (env) => this.onMatchFound(env),
      'dispatch.offer_made': (env) => this.onOfferMade(env),
      'dispatch.offer_withdrawn': (env) => this.onOfferWithdrawn(env),
      'driver.location_updated': (env) => this.onDriverLocation(env),
      'panic.triggered': (env) => this.onPanic(env),
      // Dominó del cierre de pánico: RESTAURA el feed en vivo a /family SOLO si FALSE_ALARM; si RESOLVED
      // (emergencia real) NO restaura (la máscara se mantiene — el enlace pudo ser capturado).
      'panic.resolved': (env) => this.onPanicResolved(env),
      'chat.message_sent': (env) => this.onChatMessage(env),
      // Lote C4 · desenlace de una PARADA propuesta → outcome en vivo al PASAJERO (cierra el "esperando").
      'trip.waypoint_accepted': (env) =>
        this.onWaypointOutcome(env, tripWaypointAccepted, WaypointProposalStatus.ACCEPTED),
      'trip.waypoint_rejected': (env) =>
        this.onWaypointOutcome(env, tripWaypointRejected, WaypointProposalStatus.REJECTED),
      'trip.waypoint_expired': (env) =>
        this.onWaypointOutcome(env, tripWaypointExpired, WaypointProposalStatus.EXPIRED),
    };
  }

  // ── Handlers ──

  /**
   * `trip.requested` además de propagar el status GUARDA recojo/destino en el estado vivo: son el
   * objetivo del ETA FRESCO por fase (pre-recojo → recojo; onboard → destino) que se recomputa con
   * cada ping GPS del conductor (ver `maybeRefreshEta`).
   */
  private onTripRequested(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripRequested.safeParse(env.payload);
    if (parsed.success) {
      this.state.setTripPoints(parsed.data.tripId, {
        origin: parsed.data.origin,
        destination: parsed.data.destination,
      });
      this.pushTripUpdate(parsed.data.tripId, 'REQUESTED', null);
    }
    return Promise.resolve();
  }

  /** RC5 (ADR-022) · destino reescrito pre-start → el ETA fresco apunta al destino NUEVO. */
  private onDestinationChanged(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripDestinationChanged.safeParse(env.payload);
    if (parsed.success) {
      this.state.setDestination(parsed.data.tripId, parsed.data.destination);
    }
    return Promise.resolve();
  }

  private onTripStatus(
    env: EventEnvelope<unknown>,
    schema: typeof tripRequested | typeof tripArrived | typeof tripStarted,
    status: TripStatus,
  ): Promise<void> {
    const parsed = schema.safeParse(env.payload);
    if (parsed.success) this.pushTripUpdate(parsed.data.tripId, status, null);
    return Promise.resolve();
  }

  /**
   * ADR-020 Lote 1 · `trip.bid_posted`: trip-service abrió la puja (createTrip inicial) o la RE-abrió
   * (re-bid). Empujamos `REQUESTED` al pasajero para que su máquina de fases vuelva a "buscando/ofertas"
   * al instante, SIN esperar el poll de 5s. Combinado con la invalidación del cliente en el re-bid, la app
   * refetchea el board fresco. NO usamos el `windowSec` del payload para el `expiresAt`: dispatch es la
   * autoridad del board (recalcula el `expiresAt` en openBoard) y el cliente lo obtiene por REST.
   */
  private onBidPosted(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripBidPosted.safeParse(env.payload);
    if (parsed.success) this.pushTripUpdate(parsed.data.tripId, 'REQUESTED', null);
    return Promise.resolve();
  }

  private onTripAssigned(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripAssigned.safeParse(env.payload);
    if (parsed.success) {
      this.state.setDriverTrip(parsed.data.driverId, parsed.data.tripId);
      this.pushTripUpdate(parsed.data.tripId, 'ASSIGNED', null);
    }
    return Promise.resolve();
  }

  private onTripAccepted(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripAccepted.safeParse(env.payload);
    if (parsed.success) {
      this.state.setDriverTrip(parsed.data.driverId, parsed.data.tripId);
      this.pushTripUpdate(parsed.data.tripId, 'ACCEPTED', parsed.data.etaSeconds);
    }
    return Promise.resolve();
  }

  private onTripArriving(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripArriving.safeParse(env.payload);
    if (parsed.success) {
      this.state.setDriverTrip(parsed.data.driverId, parsed.data.tripId);
      this.pushTripUpdate(parsed.data.tripId, 'ARRIVING', parsed.data.etaSeconds);
    }
    return Promise.resolve();
  }

  private onTripEnded(
    env: EventEnvelope<unknown>,
    schema: typeof tripCompleted | typeof tripCancelled,
    status: TripStatus,
  ): Promise<void> {
    const parsed = schema.safeParse(env.payload);
    if (parsed.success) {
      const at = new Date().toISOString();
      this.state.setStatus(parsed.data.tripId, status);
      this.gateway.emitTripEnded(parsed.data.tripId, status, at);
      this.passenger.emitTripEnded(parsed.data.tripId, status, at);
      this.state.clearTrip(parsed.data.tripId);
      this.lastEtaComputeAt.delete(parsed.data.tripId);
    }
    return Promise.resolve();
  }

  /**
   * La puja cerró sin ofertas (o el viaje expiró estancado): el pasajero pasa a EXPIRED. NO es
   * terminal — el cliente muestra la pantalla "sin ofertas" y puede re-pujar más alto. Se emite como
   * `trip:update` (no `trip:ended`) para que la app no lo trate como viaje cerrado.
   */
  private onTripExpired(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripExpired.safeParse(env.payload);
    if (parsed.success) this.pushTripUpdate(parsed.data.tripId, 'EXPIRED', null);
    return Promise.resolve();
  }

  /**
   * El watchdog cerró un viaje EN CURSO abandonado: FAILED es TERMINAL. Se emite como `trip:ended`
   * (igual que completed/cancelled) para que el cliente salga del viaje y libere el seguimiento.
   */
  private onTripFailed(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripFailed.safeParse(env.payload);
    if (parsed.success) {
      const at = new Date().toISOString();
      this.state.setStatus(parsed.data.tripId, 'FAILED');
      this.gateway.emitTripEnded(parsed.data.tripId, 'FAILED', at);
      this.passenger.emitTripEnded(parsed.data.tripId, 'FAILED', at);
      this.state.clearTrip(parsed.data.tripId);
      this.lastEtaComputeAt.delete(parsed.data.tripId);
    }
    return Promise.resolve();
  }

  /**
   * El conductor canceló pre-recojo: el viaje vuelve a buscar/re-puja (REASSIGNING, transitorio). El
   * pasajero ve "tu conductor canceló, buscando otro" en vez de quedar congelado con el pin del
   * conductor que ya no viene. El driver→trip viejo se limpia para no enrutar su ubicación a este viaje.
   */
  private onTripReassigning(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = tripReassigning.safeParse(env.payload);
    if (parsed.success) {
      this.state.clearDriver(parsed.data.driverId);
      this.pushTripUpdate(parsed.data.tripId, 'REASSIGNING', null);
    }
    return Promise.resolve();
  }

  private onMatchFound(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = dispatchMatchFound.safeParse(env.payload);
    if (parsed.success) {
      this.state.setDriverTrip(parsed.data.driverId, parsed.data.tripId);
      this.pushTripUpdate(
        parsed.data.tripId,
        this.state.getStatus(parsed.data.tripId) ?? 'MATCHING',
        null,
      );
    }
    return Promise.resolve();
  }

  /**
   * Una oferta entró a la puja del pasajero (ADR 010 · `dispatch.offer_made`). Se reenvía a la sala
   * del viaje del pasajero (`/passenger`) para que vea "N conductores respondieron" en vivo. No toca
   * /family (la negociación es del pasajero, no del seguimiento familiar). El tripId del board ES el
   * viaje del pasajero, así que no hace falta el mapa driver→trip.
   */
  private onOfferMade(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = dispatchOfferMade.safeParse(env.payload);
    if (parsed.success) {
      // ADR-020 Lote 1 · una oferta entrando implica board ABIERTO: fijamos el status a REQUESTED para que
      // la reconexión (emitSnapshot) NO re-empuje un EXPIRED stale de un ciclo previo sin ofertas sobre un
      // board sano. No emitimos trip:update aquí (la oferta ya viaja por `offer:made`); solo memorizamos.
      this.state.setStatus(parsed.data.tripId, 'REQUESTED');
      this.passenger.emitOfferMade(parsed.data.tripId, {
        tripId: parsed.data.tripId,
        driverId: parsed.data.driverId,
        kind: parsed.data.kind,
        priceCents: parsed.data.priceCents,
        etaSeconds: parsed.data.etaSeconds,
        at: new Date().toISOString(),
      });
    }
    return Promise.resolve();
  }

  /**
   * BE-3 · una oferta dejó de ser válida con el board abierto (`dispatch.offer_withdrawn`): se reenvía a
   * la sala del pasajero para que QUITE esa card al instante (sin esperar el refetch). No toca /family.
   */
  private onOfferWithdrawn(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = dispatchOfferWithdrawn.safeParse(env.payload);
    if (parsed.success) {
      this.passenger.emitOfferWithdrawn(parsed.data.tripId, {
        tripId: parsed.data.tripId,
        driverId: parsed.data.driverId,
        at: new Date().toISOString(),
      });
    }
    return Promise.resolve();
  }

  private onDriverLocation(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverLocationUpdated.safeParse(env.payload);
    if (!parsed.success) return Promise.resolve();
    const tripId = this.state.tripForDriver(parsed.data.driverId);
    if (!tripId) return Promise.resolve();
    // Fan-out a QUIEN esté escuchando: el PASAJERO (socket /passenger) y/o la FAMILIA (link /family).
    // Antes el gate usaba solo `isActive` (suscriptores /family) → el pasajero NUNCA veía el taxi
    // moverse salvo que hubiera un familiar mirando el share. Cada gateway aplica su propio filtro
    // (passenger: isPassengerActive · family: isActive + corte por isPanicked), así que acá solo
    // evitamos trabajo cuando NADIE escucha.
    if (!this.state.isActive(tripId) && !this.state.isPassengerActive(tripId)) {
      return Promise.resolve();
    }
    const point = { lat: parsed.data.point.lat, lon: parsed.data.point.lon };
    this.state.setLocation(tripId, { point, at: parsed.data.at });
    const locationMsg = {
      tripId,
      driverId: parsed.data.driverId,
      point,
      heading: parsed.data.heading ?? null,
      speedKph: null,
      at: parsed.data.at,
    };
    this.gateway.emitDriverLocation(tripId, locationMsg);
    this.passenger.emitDriverLocation(tripId, locationMsg);
    // ETA FRESCO por fase (A2 del flujo de mapa): fire-and-forget para no bloquear el fan-out del pin.
    void this.maybeRefreshEta(tripId, point);
    return Promise.resolve();
  }

  /**
   * Recomputa el ETA del pasajero desde la posición VIVA del conductor (antes el ETA se fijaba UNA
   * vez en accept/arriving — con defaults del cliente — y quedaba stale todo el viaje). Por fase:
   *  - pre-recojo (ACCEPTED/ARRIVING/ARRIVED): conductor → recojo ("tu conductor llega en X").
   *  - onboard (IN_PROGRESS): conductor → destino ("llegás en X").
   * THROTTLE de 15s por viaje (misma cadencia que el poll de ruta del conductor): un ping cada 2-3s
   * NO dispara un OSRM por ping. Fail-soft: si maps no responde, se conserva el último ETA (mejor
   * stale que romper el fan-out). Si el BFF (re)arrancó mid-trip y no tiene los puntos del viaje,
   * degrada honesto (sin recompute) hasta el próximo viaje.
   */
  private async maybeRefreshEta(tripId: string, driverAt: GeoPoint): Promise<void> {
    const status = this.state.getStatus(tripId);
    if (!status || !ETA_PHASES.has(status)) return;
    const points = this.state.getTripPoints(tripId);
    if (!points) return;
    const now = Date.now();
    const last = this.lastEtaComputeAt.get(tripId) ?? 0;
    if (now - last < ETA_REFRESH_MS) return;
    this.lastEtaComputeAt.set(tripId, now);
    try {
      const target = isOnboard(status) ? points.destination : points.origin;
      const etaSeconds = await this.maps.eta(driverAt, target);
      this.state.setEta(tripId, etaSeconds);
      this.passenger.emitEta(tripId, { tripId, etaSeconds, at: new Date().toISOString() });
    } catch (err: unknown) {
      // Fail-soft: el último ETA emitido sigue vigente; el próximo ping (post-throttle) reintenta.
      this.log.warn({ err, tripId }, 'no se pudo recomputar el ETA en vivo');
    }
  }

  /**
   * Mensaje de chat (Ola 2A): emite `chat:message` a la sala del viaje del pasajero. El pasajero
   * recibe los mensajes del conductor (y los suyos en otras sesiones); el BFF no filtra por rol aquí
   * porque el gateway solo entrega a la sala del propio viaje del pasajero autenticado.
   */
  private onChatMessage(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = chatMessageSent.safeParse(env.payload);
    if (parsed.success) {
      const msg: ChatMessage = {
        id: parsed.data.messageId,
        tripId: parsed.data.tripId,
        senderId: parsed.data.senderId,
        senderRole: parsed.data.senderRole,
        body: parsed.data.body,
        createdAt: parsed.data.createdAt,
      };
      this.passenger.emitChatMessage(parsed.data.tripId, msg);
    }
    return Promise.resolve();
  }

  /**
   * Lote C4 · desenlace de una parada propuesta. Reenvía al PASAJERO (`waypoint:outcome`) el estado
   * TERMINAL (ACCEPTED/REJECTED/EXPIRED) para que cierre el "esperando al conductor". Los tres eventos
   * comparten {proposalId} en el payload; el `status` lo fija el tipo de evento (typed, sin string suelto).
   * No toca /family (la negociación de la parada es del pasajero, no del seguimiento familiar).
   */
  private onWaypointOutcome(
    env: EventEnvelope<unknown>,
    schema: typeof tripWaypointAccepted | typeof tripWaypointRejected | typeof tripWaypointExpired,
    status: WaypointProposalStatus,
  ): Promise<void> {
    const parsed = schema.safeParse(env.payload);
    if (parsed.success) {
      this.passenger.emitWaypointOutcome(parsed.data.tripId, {
        proposalId: parsed.data.proposalId,
        status,
      });
    }
    return Promise.resolve();
  }

  /**
   * SEGURIDAD-CRÍTICA · pánico oculto (VEO_SPEC_FAMILIA, fail-safe = ocultar).
   *
   * Antes este handler hacía `pushTripUpdate`, lo que mantenía a la familia informada EN VIVO durante
   * el pánico: una puerta trasera al enmascarado REST (un agresor mirando el enlace seguía viendo la
   * ubicación moverse). Ahora cortamos el canal /family del viaje: marcamos el viaje como en pánico
   * (suprime todo fan-out futuro a /family) y desconectamos los sockets de la familia ya conectados.
   * La familia cae a la vista REST enmascarada (viaje "TERMINADO") en su siguiente poll.
   *
   * NOTA: NO tocamos el namespace /passenger — la víctima debe seguir viendo su viaje con normalidad
   * para no delatar que el pánico se disparó.
   */
  private onPanic(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = panicTriggered.safeParse(env.payload);
    if (parsed.success) {
      this.gateway.cutFamilyForPanic(parsed.data.tripId);
      this.log.warn(
        { tripId: parsed.data.tripId },
        'pánico: canal /family cortado (seguimiento en vivo suprimido)',
      );
    }
    return Promise.resolve();
  }

  /**
   * SEGURIDAD-CRÍTICA · cierre de pánico (VEO_SPEC_FAMILIA, fail-safe = ocultar).
   *
   * El operador cerró la alerta (`panic.resolved`, no forjable: detrás de RolesGuard + PANIC_OPERATORS).
   * DESENMASCARADO CONDICIONAL (decisión del dueño, conservadora) ramificado por el enum TIPADO:
   *  - `FALSE_ALARM`: levanta la marca de pánico (`clearPanic`) → el fan-out en vivo a /family vuelve a
   *    fluir. La familia recupera el seguimiento en su próxima reconexión/poll.
   *  - `RESOLVED` (emergencia REAL atendida): NO restaura. La máscara se MANTIENE porque el enlace pudo
   *    ser capturado por el agresor; restaurar la ubicación en vivo lo expondría. NO-OP deliberado.
   *
   * El payload trae el `tripId` enriquecido (panic-service lo añade desde la fila PanicEvent).
   */
  private onPanicResolved(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = panicResolved.safeParse(env.payload);
    if (parsed.success && parsed.data.status === PanicStatus.FALSE_ALARM) {
      this.state.clearPanic(parsed.data.tripId);
      this.log.warn(
        { tripId: parsed.data.tripId },
        'pánico cerrado (falsa alarma): canal /family restaurado',
      );
    }
    return Promise.resolve();
  }

  /** Actualiza el estado y emite trip:update (y `eta` al pasajero) con la última ubicación conocida. */
  private pushTripUpdate(tripId: string, status: TripStatus, etaSeconds: number | null): void {
    this.state.setStatus(tripId, status);
    if (etaSeconds !== null) this.state.setEta(tripId, etaSeconds);
    const loc = this.state.getLocation(tripId);
    const at = new Date().toISOString();
    const update = {
      tripId,
      status,
      etaSeconds: etaSeconds ?? this.state.getEta(tripId),
      driverLocation: loc?.point ?? null,
      at,
    };
    this.gateway.emitTripUpdate(tripId, update);
    this.passenger.emitTripUpdate(tripId, update);
    if (etaSeconds !== null) this.passenger.emitEta(tripId, { tripId, etaSeconds, at });
  }
}
