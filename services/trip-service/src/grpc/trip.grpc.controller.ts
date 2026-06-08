/**
 * Controlador gRPC de trip (paquete veo.trip.v1.TripService).
 * Lectura síncrona del viaje para otros servicios. Devuelve `found=false` en vez de lanzar,
 * para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { NotFoundError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { LIVE_STATES } from '../trips/domain/trip-state-machine';
import { TripsService } from '../trips/trips.service';
import { TripQueryService } from '../trips/trip-query.service';
import type { TripView } from '../trips/dto/trip.dto';
import type { Trip } from '../generated/prisma';

interface GetByIdRequest {
  id: string;
}

interface ActiveTripRequest {
  passengerId: string;
}

interface PendingSettlementRequest {
  passengerId: string;
}

interface CloseTripRequest {
  id: string;
  passengerId: string;
}

interface TripReply {
  id: string;
  passengerId: string;
  driverId: string;
  vehicleId: string;
  status: string;
  fareCents: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  /// Ola 2B · tier moto-taxi: tipo de vehículo solicitado (CAR|MOTO).
  vehicleType: string;
  /// Ola 2B · viaje programado: ISO-8601 si el viaje es/era programado; '' si inmediato.
  scheduledFor: string;
  /// Re-entrada del cierre post-viaje: ISO-8601 de cuándo el pasajero selló el cierre; '' si aún sin cerrar.
  passengerClosedAt: string;
  /// Detalle de "Mis Viajes" (enriquecimiento): timestamps reales. requestedAt SIEMPRE presente;
  /// completedAt/cancelledAt '' (proto3) si no aplican (el BFF los re-mapea a null).
  requestedAt: string;
  completedAt: string;
  cancelledAt: string;
  /// Puntos del viaje (lat/lng; sin label: el schema solo persiste lat/lon).
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  /// Ruta del viaje (polyline persistida en Trip.routePolyline); '' si el viaje no la tiene (→ null en el BFF).
  routePolyline: string;
  found: boolean;
}

interface TripStateReply {
  id: string;
  status: string;
  found: boolean;
}

interface ListPassengerTripsRequest {
  passengerId: string;
  cursor: string;
  limit: number;
}

interface TripHistoryItemReply {
  id: string;
  status: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  fareCents: number;
  currency: string;
  paymentMethod: string;
  distanceMeters: number;
  durationSeconds: number;
  requestedAt: string;
  completedAt: string;
  cancelledAt: string;
  driverId: string;
  vehicleType: string;
  category: string;
}

interface PassengerTripsReply {
  items: TripHistoryItemReply[];
  nextCursor: string;
}

const EMPTY_TRIP: TripReply = {
  id: '',
  passengerId: '',
  driverId: '',
  vehicleId: '',
  status: '',
  fareCents: 0,
  currency: '',
  distanceMeters: 0,
  durationSeconds: 0,
  paymentMethod: '',
  childMode: false,
  penaltyCents: 0,
  vehicleType: '',
  scheduledFor: '',
  passengerClosedAt: '',
  requestedAt: '',
  completedAt: '',
  cancelledAt: '',
  originLat: 0,
  originLng: 0,
  destinationLat: 0,
  destinationLng: 0,
  routePolyline: '',
  found: false,
};

@Controller()
export class TripGrpcController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly query: TripQueryService,
  ) {}

  @GrpcMethod('TripService', 'GetTrip')
  async getTrip({ id }: GetByIdRequest): Promise<TripReply> {
    const t = await this.prisma.read.trip.findUnique({ where: { id } });
    if (!t) return EMPTY_TRIP;
    return this.toReply(t);
  }

  /**
   * Viaje ACTIVO (vivo) del pasajero, sin conocer su id: la app lo usa para REHIDRATAR el flujo
   * unificado al (re)entrar (el sheet vuelve al estado real) y para el banner cross-tab. "Vivo" =
   * LIVE_STATES (no terminal, no programado). Como el invariante "un solo viaje vivo" lo garantiza
   * createTrip (409), normalmente hay 0 o 1; ordenamos por requestedAt desc por robustez. found=false
   * si no hay ninguno (la app interpreta "sin viaje activo", no es un error).
   */
  @GrpcMethod('TripService', 'GetActiveTrip')
  async getActiveTrip({ passengerId }: ActiveTripRequest): Promise<TripReply> {
    const t = await this.prisma.read.trip.findFirst({
      where: { passengerId, status: { in: [...LIVE_STATES] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!t) return EMPTY_TRIP;
    return this.toReply(t);
  }

  /**
   * Pending settlement (re-entrada del cierre): el viaje MÁS VIEJO COMPLETED del pasajero sin cerrar
   * (passengerClosedAt = null), orden completedAt ASC. found=false si no hay ninguno. COMPLETED es
   * TERMINAL → queda FUERA de LIVE_STATES, así que GetActiveTrip no lo devuelve y el pasajero perdería
   * el cierre (recibo/efectivo/rating) tras un reload. Espeja EXACTO a GetActiveTrip (mismo TripReply,
   * mismo found-pattern): el BFF lo enriquece igual que la vista activa.
   *
   * ORDEN FIFO (asc, el más VIEJO primero): si quedan varios COMPLETED sin cerrar, se drenan en cascada
   * del más antiguo al más nuevo, así la plata de un efectivo VIEJO no queda enterrada bajo viajes nuevos.
   */
  @GrpcMethod('TripService', 'GetPendingSettlementTrip')
  async getPendingSettlementTrip({ passengerId }: PendingSettlementRequest): Promise<TripReply> {
    const t = await this.prisma.read.trip.findFirst({
      where: { passengerId, status: TripStatus.COMPLETED, passengerClosedAt: null },
      orderBy: { completedAt: 'asc' },
    });
    if (!t) return EMPTY_TRIP;
    return this.toReply(t);
  }

  /**
   * Cierre post-viaje por el pasajero (re-entrada): sella passengerClosedAt sobre SU viaje COMPLETED.
   * Delega en TripsService.closeByPassenger (idempotente; NO toca la máquina de estados — COMPLETED
   * sigue terminal). Anti-enumeración: viaje inexistente o de OTRO pasajero → found=false (no se filtra
   * existencia ajena, mismo criterio que los reads). Éxito (incluido el cierre repetido idempotente) →
   * found=true con el viaje. Una ConflictError (viaje no COMPLETED) propaga como error gRPC (el BFF ya
   * verificó ownership antes de delegar; el pending-settlement solo ofrece cerrar viajes COMPLETED).
   */
  @GrpcMethod('TripService', 'CloseTripByPassenger')
  async closeTripByPassenger({ id, passengerId }: CloseTripRequest): Promise<TripReply> {
    try {
      // closeByPassenger YA devuelve el TripView (con el sello aplicado): lo mapeamos directo al
      // contrato gRPC, sin un re-read a prisma.read (que además, por réplica, podría leer una fila
      // todavía sin el passengerClosedAt recién escrito). Ver tripViewToReply.
      const view = await this.trips.closeByPassenger(id, passengerId);
      return this.tripViewToReply(view);
    } catch (err) {
      if (err instanceof NotFoundError) return EMPTY_TRIP; // ajeno/inexistente: no se filtra existencia
      throw err;
    }
  }

  /** Mapea la fila Trip al contrato gRPC TripReply (found=true). Compartido por GetTrip/GetActiveTrip. */
  private toReply(t: Trip): TripReply {
    return {
      id: t.id,
      passengerId: t.passengerId,
      driverId: t.driverId ?? '',
      vehicleId: t.vehicleId ?? '',
      status: t.status,
      fareCents: t.fareCents,
      currency: t.currency,
      distanceMeters: t.distanceMeters,
      durationSeconds: t.durationSeconds,
      paymentMethod: t.paymentMethod,
      childMode: t.childMode,
      penaltyCents: t.penaltyCents,
      vehicleType: t.vehicleType,
      scheduledFor: t.scheduledFor ? t.scheduledFor.toISOString() : '',
      // proto3 no tiene null para string: '' = aún sin cerrar; el BFF lo re-mapea a null.
      passengerClosedAt: t.passengerClosedAt ? t.passengerClosedAt.toISOString() : '',
      // Enriquecimiento "Mis Viajes": timestamps reales (requestedAt siempre; completed/cancelled '' si no aplican),
      // puntos del viaje (la fila guarda lon → lo exponemos como lng, igual que TripHistoryItem) y la polyline persistida.
      requestedAt: t.requestedAt.toISOString(),
      completedAt: t.completedAt ? t.completedAt.toISOString() : '',
      cancelledAt: t.cancelledAt ? t.cancelledAt.toISOString() : '',
      originLat: t.originLat,
      originLng: t.originLon,
      destinationLat: t.destLat,
      destinationLng: t.destLon,
      routePolyline: t.routePolyline ?? '',
      found: true,
    };
  }

  /**
   * Mapea un TripView (ya serializado por TripsService.toView: fechas ISO, null para sin-valor) al
   * contrato gRPC TripReply, SIN re-leer la fila. Lo usa CloseTripByPassenger, que recibe el view con el
   * cierre ya sellado. proto3 colapsa null→'' en los string opcionales (driverId/vehicleId/scheduledFor/
   * passengerClosedAt). No duplica `toReply`: éste parte del TripView (ya transformado), no de la fila Trip.
   */
  private tripViewToReply(v: TripView): TripReply {
    return {
      id: v.id,
      passengerId: v.passengerId,
      driverId: v.driverId ?? '',
      vehicleId: v.vehicleId ?? '',
      status: v.status,
      fareCents: v.fareCents,
      currency: v.currency,
      distanceMeters: v.distanceMeters,
      durationSeconds: v.durationSeconds,
      paymentMethod: v.paymentMethod,
      childMode: v.childMode,
      penaltyCents: v.penaltyCents,
      vehicleType: v.vehicleType,
      scheduledFor: v.scheduledFor ?? '',
      passengerClosedAt: v.passengerClosedAt ?? '',
      // Enriquecimiento "Mis Viajes": el TripView ya trae las fechas ISO (null para sin-valor → '') y los
      // puntos como {lat,lon}; los exponemos como lat/lng (consistencia TripHistoryItem). Polyline persistida.
      requestedAt: v.requestedAt,
      completedAt: v.completedAt ?? '',
      cancelledAt: v.cancelledAt ?? '',
      originLat: v.origin.lat,
      originLng: v.origin.lon,
      destinationLat: v.destination.lat,
      destinationLng: v.destination.lon,
      routePolyline: v.routePolyline ?? '',
      found: true,
    };
  }

  @GrpcMethod('TripService', 'GetTripState')
  async getTripState({ id }: GetByIdRequest): Promise<TripStateReply> {
    const t = await this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!t) return { id: '', status: '', found: false };
    return { id: t.id, status: t.status, found: true };
  }

  /**
   * Historial REAL del pasajero (servidor, no la lista local MMKV): SUS viajes ordenados por requestedAt
   * DESC, id DESC, paginados por cursor opaco. Delega en TripsService.listPassengerTrips (keyset, clamp
   * del limit, anti-N+1). El passengerId lo fija el BFF desde el JWT (anti-IDOR); acá solo se confía y se
   * filtra por él (un viaje de OTRO pasajero NUNCA puede aparecer porque el `where` siempre lleva
   * passengerId). proto3 colapsa los string opcionales (completedAt/cancelledAt/driverId/category/
   * nextCursor) a '' cuando son null.
   */
  @GrpcMethod('TripService', 'ListPassengerTrips')
  async listPassengerTrips({
    passengerId,
    cursor,
    limit,
  }: ListPassengerTripsRequest): Promise<PassengerTripsReply> {
    const page = await this.query.listPassengerTrips(passengerId, cursor || undefined, limit || undefined);
    return {
      items: page.items.map((it) => ({
        id: it.id,
        status: it.status,
        originLat: it.origin.lat,
        originLng: it.origin.lng,
        destinationLat: it.destination.lat,
        destinationLng: it.destination.lng,
        fareCents: it.fareCents,
        currency: it.currency,
        paymentMethod: it.paymentMethod,
        distanceMeters: it.distanceMeters,
        durationSeconds: it.durationSeconds,
        requestedAt: it.requestedAt,
        completedAt: it.completedAt ?? '',
        cancelledAt: it.cancelledAt ?? '',
        driverId: it.driverId ?? '',
        vehicleType: it.vehicleType,
        category: it.category ?? '',
      })),
      // proto3 no tiene null para string: '' = no hay siguiente página; el BFF lo re-mapea a null.
      nextCursor: page.nextCursor ?? '',
    };
  }
}
