/**
 * Consumidor Kafka que alimenta el seguimiento en vivo del namespace /family.
 * Suscrito a los topics `trip`, `dispatch`, `panic` y `driver` (driver.location_updated).
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
  panicTriggered,
  tripAccepted,
  tripArrived,
  tripArriving,
  tripAssigned,
  tripCancelled,
  tripCompleted,
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
import { createLogger, type Logger } from '@veo/observability';
import { WaypointProposalStatus, type ChatMessage, type TripStatus } from '@veo/api-client';
import { FamilyGateway } from './family.gateway';
import { PassengerGateway } from './passenger.gateway';
import { RealtimeStateService } from './realtime-state.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este BFF. */
const KAFKA_CLIENT_ID = 'public-bff';

/** Group del tiempo real de public-bff. */
const REALTIME_GROUP_ID = 'public-bff-realtime';

@Injectable()
export class RealtimeConsumerService extends KafkaConsumerBootstrap {
  private readonly log: Logger = createLogger('public-bff:realtime');

  constructor(
    config: ConfigService<Env, true>,
    private readonly gateway: FamilyGateway,
    private readonly passenger: PassengerGateway,
    private readonly state: RealtimeStateService,
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
      'trip.requested': (env) => this.onTripStatus(env, tripRequested, 'REQUESTED'),
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

  private onTripStatus(
    env: EventEnvelope<unknown>,
    schema: typeof tripRequested | typeof tripArrived | typeof tripStarted,
    status: TripStatus,
  ): Promise<void> {
    const parsed = schema.safeParse(env.payload);
    if (parsed.success) this.pushTripUpdate(parsed.data.tripId, status, null);
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
      this.pushTripUpdate(parsed.data.tripId, this.state.getStatus(parsed.data.tripId) ?? 'MATCHING', null);
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
    return Promise.resolve();
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
      this.passenger.emitWaypointOutcome(parsed.data.tripId, { proposalId: parsed.data.proposalId, status });
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
      this.log.warn({ tripId: parsed.data.tripId }, 'pánico: canal /family cortado (seguimiento en vivo suprimido)');
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
