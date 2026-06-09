/**
 * Viajes (lado conductor).
 *  - Lecturas (GetTrip, GetTripState) por gRPC.
 *  - Comandos de la máquina de estados (accept/arriving/arrived/start/complete/cancel) por REST.
 * El tracking GPS se envía por el evento Socket.IO `location` del gateway /driver (soberanía: no MQTT),
 * que publica `driver.location_updated` a Kafka.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type { LatLon, MapsClient } from '@veo/maps';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import { MAPS } from '../infra/maps.client';
import type { DriverReply, TripReply, TripStateReply } from '../common/grpc-replies';
import type { AcceptTripDto, ArrivingTripDto, CancelTripDto, CompleteTripDto, StartTripDto, TripRouteView, TripStateView, TripView } from './dto/trips.dto';

/** Recurso del viaje tal como lo devuelve trip-service por REST (campos que necesita la navegación). */
interface TripResourceReply {
  id: string;
  origin: LatLon;
  destination: LatLon;
  waypoints: LatLon[];
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

export function toTripView(trip: TripReply): TripView {
  return {
    id: trip.id,
    passengerId: trip.passengerId,
    driverId: emptyToNull(trip.driverId),
    vehicleId: emptyToNull(trip.vehicleId),
    status: trip.status,
    fareCents: trip.fareCents,
    currency: trip.currency,
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    paymentMethod: trip.paymentMethod,
    childMode: trip.childMode,
    penaltyCents: trip.penaltyCents,
  };
}

@Injectable()
export class TripsService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
    @Inject(MAPS) private readonly maps: MapsClient,
  ) {}

  async getTrip(id: string, identity: AuthenticatedUser): Promise<TripView> {
    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id }, identity);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    // A1 · ownership server-side (anti-IDOR): TripView lleva passengerId/paymentMethod/childMode (PII del
    // viaje). Sin gate, cualquier conductor enumeraba datos de viajes ajenos por id. Deriva el driverId
    // del perfil y exige que el viaje sea de ESTE conductor. 404 (no 403) para no filtrar su existencia.
    // Seguro: la tarjeta de puja PRE-aceptación sale de dispatch (/bids/open); getTrip es POST-asignación.
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found || trip.driverId !== driver.id) {
      throw new NotFoundError('Viaje no encontrado');
    }
    return toTripView(trip);
  }

  async getTripState(id: string, identity: AuthenticatedUser): Promise<TripStateView> {
    const state = await this.grpc.call<TripStateReply>('trip', 'GetTripState', { id }, identity);
    if (!state.found) throw new NotFoundError('Viaje no encontrado');
    return { id: state.id, status: state.status };
  }

  /**
   * Ola 2C · navegación turn-by-turn. Verifica (gRPC) que el viaje está asignado a ESTE conductor,
   * resuelve origen/recojo/destino (con waypoints) del recurso REST de trip-service y calcula la ruta
   * CON pasos vía la fachada soberana @veo/maps (OSRM `steps=true`, fallback al motor local en dev).
   * La ruta cubre recojo (origin) → paradas → destino.
   */
  async route(id: string, identity: AuthenticatedUser): Promise<TripRouteView> {
    // A1 · ownership server-side (anti-IDOR): la ruta expone origin/destino/paradas (PII de ubicación
    // EXACTA) → verificamos que el viaje es de ESTE conductor ANTES de resolverla. Sin esto, cualquier
    // conductor con un tripId ajeno leía el recojo/paradas/destino de un viaje que no es suyo (mismo
    // patrón que accept/arriving/start/complete; faltaba SOLO acá).
    await this.assertDriverTrip(id, identity);

    const resource = await this.rest
      .client('trip')
      .get<TripResourceReply>(`/trips/${id}`, { identity });

    const route = await this.maps.routeWithSteps(
      resource.origin,
      resource.destination,
      resource.waypoints ?? [],
    );
    return {
      polyline: route.polyline,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      steps: route.steps.map((s) => ({
        instruction: s.instruction,
        distanceMeters: s.distanceMeters,
        maneuver: s.maneuver,
        geometryPolyline: s.geometryPolyline,
      })),
      // Markers del mapa: recojo, destino y paradas (Ola 2B) — el recurso REST ya los trae.
      origin: resource.origin,
      destination: resource.destination,
      waypoints: resource.waypoints ?? [],
    };
  }

  // A1 · ownership server-side (anti-IDOR): las transiciones pre-recojo del conductor verifican que el
  // viaje es de ESTE conductor ANTES de avanzar la máquina de estados (deriva el driverId del perfil y lo
  // pasa al trip-service como 2da capa). Sin esto, un conductor con un tripId ajeno podía dispararle
  // accept/arriving/arrived. Mismo patrón que start/complete/cancel.
  async accept(id: string, dto: AcceptTripDto, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/accept`, { identity: { ...identity, driverId }, body: { ...dto, driverId } });
  }

  async arriving(id: string, dto: ArrivingTripDto, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/arriving`, { identity: { ...identity, driverId }, body: { ...dto, driverId } });
  }

  async arrived(id: string, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/arrived`, { identity: { ...identity, driverId }, body: { driverId } });
  }

  /**
   * A1 · ownership server-side (anti-IDOR). ANTES de iniciar (y de exponer el código de modo niño a
   * prueba de fuerza bruta), verifica que el viaje es de ESTE conductor: deriva su driverId del perfil
   * (GetDriverByUser → driver.id) y lo compara con trip.driverId (mismo patrón que chat.service). El
   * driverId DERIVADO viaja al trip-service en el body (2da capa de defensa allí), nunca uno del cliente.
   */
  async start(id: string, dto: StartTripDto, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/start`, { identity: { ...identity, driverId }, body: { ...dto, driverId } });
  }

  /** Verifica (gRPC) que el viaje está asignado a ESTE conductor y devuelve su driverId derivado. */
  private async assertDriverTrip(tripId: string, identity: AuthenticatedUser): Promise<string> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) throw new ForbiddenException('No existe perfil de conductor para el usuario');

    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id: tripId }, identity);
    if (!trip.found) throw new NotFoundException('Viaje no encontrado');
    if (trip.driverId !== driver.id) {
      throw new ForbiddenException('El viaje no está asignado a este conductor');
    }
    return driver.id;
  }

  /**
   * EFECTIVO (decisión del dueño) · el conductor da por terminado el viaje y, si es CASH, marca que
   * COBRÓ el efectivo en mano (`cashCollected`) — su lado de la confirmación bilateral (driverConfirmed,
   * BR-P03). Anti-IDOR: ANTES de completar, deriva el driverId del perfil (GetDriverByUser → driver.id)
   * y verifica que el viaje es de ESTE conductor (assertDriverTrip); el driverId DERIVADO viaja al
   * trip-service en el body (2da capa de defensa allí), NUNCA uno del cliente. trip-service propaga
   * cashCollected en trip.completed SOLO si el viaje es CASH → payment crea la CashConfirmation con
   * driverConfirmed=true y empuja al pasajero "confirma tu pago en efectivo". En digital el flag se ignora.
   */
  async complete(id: string, dto: CompleteTripDto, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/complete`, {
      identity: { ...identity, driverId },
      body: { cashCollected: dto.cashCollected, driverId },
    });
  }

  /**
   * A1 · ownership server-side (anti-IDOR). ANTES de cancelar, deriva el driverId del perfil
   * (GetDriverByUser → driver.id) y verifica que el viaje es de ESTE conductor (assertDriverTrip).
   * Sin esto, un conductor con un tripId ajeno podía cancelar —o forzar la reasignación POST-accept—
   * el viaje de otro (penalizándolo y dejando colgado al pasajero). `by` se fija a DRIVER (no se confía
   * en el cliente) y el driverId DERIVADO viaja al trip-service en el body (2da capa de defensa allí),
   * nunca uno del cliente. Mismo patrón que accept/arriving/arrived/start/complete.
   */
  async cancel(id: string, dto: CancelTripDto, identity: AuthenticatedUser): Promise<unknown> {
    const driverId = await this.assertDriverTrip(id, identity);
    return this.trip().post(`/trips/${id}/cancel`, {
      identity: { ...identity, driverId },
      body: { by: 'DRIVER', reason: dto.reason, driverId },
    });
  }

  private trip() {
    return this.rest.client('trip');
  }
}
