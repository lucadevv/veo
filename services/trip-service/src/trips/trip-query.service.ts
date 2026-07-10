/**
 * TripQueryService — lado de LECTURA del viaje (CQRS). Extraído de TripsService (#6, SRP): el
 * service de escritura orquesta la máquina de estados; las consultas viven aquí. Sin mutaciones,
 * sin outbox. Mapea con toTripView (trip-view.mapper) y pagina el historial con domain/history.
 *
 * Fuente Prisma por método (se conserva el comportamiento previo): getTrip lee del PRIMARIO
 * (read-after-write del detalle, como el viejo mustFind); el resto lee de la RÉPLICA.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import { TripQueryRepository } from './trip-query.repository';
import { toTripView } from './trip-view.mapper';
import {
  clampLimit,
  decodeCursor,
  driverHistoryWhere,
  encodeCursor,
  historyWhere,
  tripToHistoryItem,
  type TripHistoryPage,
} from './domain/history';
import type { TripView } from './dto/trip.dto';

@Injectable()
export class TripQueryService {
  constructor(private readonly repo: TripQueryRepository) {}

  async getTrip(id: string): Promise<TripView> {
    const trip = await this.repo.findByIdOnPrimary(id);
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return toTripView(trip);
  }

  async getTripState(id: string): Promise<{ id: string; status: TripStatus }> {
    const trip = await this.repo.findStatusById(id);
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return { id: trip.id, status: trip.status };
  }

  /**
   * GET /trips/scheduled?passengerId= — viajes PROGRAMADOS aún no activados de un pasajero (Ola 2B).
   * Orden ascendente por hora programada (los más próximos primero).
   */
  async listScheduled(passengerId: string): Promise<TripView[]> {
    const trips = await this.repo.findScheduledByPassenger(passengerId);
    return trips.map((t) => toTripView(t));
  }

  /**
   * Historial REAL del pasajero (servidor, no MMKV local): SUS viajes ordenados por requestedAt DESC,
   * id DESC, paginados por CURSOR (keyset). Es la fuente de verdad de los ESTADOS reales (COMPLETED /
   * CANCELLED_* / EXPIRED), que la lista local de la app no tiene. El passengerId lo fija el BFF desde
   * el JWT (anti-IDOR): este método NUNCA recibe el id del cliente.
   *
   * Paginación keyset (no offset): pedimos `take = limit + 1` para SABER si hay siguiente página sin un
   * COUNT extra. Si vinieron limit+1 filas, la última sobra (es el "peek"): la usamos para construir el
   * nextCursor y la recortamos. Si vinieron ≤ limit, no hay más (nextCursor = null).
   *
   * Anti-N+1: el item NO trae el nombre del conductor (solo driverId). La card muestra tier+ruta+monto+
   * estado; el nombre lo resuelve el DETALLE (GetTrip) on-demand al abrir el viaje.
   */
  async listPassengerTrips(
    passengerId: string,
    rawCursor?: string,
    rawLimit?: number,
  ): Promise<TripHistoryPage> {
    const limit = clampLimit(rawLimit);
    const cursor = decodeCursor(rawCursor);
    // peek: 1 fila extra (limit + 1) para saber si hay siguiente página sin COUNT
    const rows = await this.repo.findHistoryPage(historyWhere(passengerId, cursor), limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ requestedAt: last.requestedAt.toISOString(), id: last.id })
        : null;
    return { items: page.map((t) => tripToHistoryItem(t)), nextCursor };
  }

  /**
   * Historial REAL del CONDUCTOR (servidor, no MMKV local): SUS viajes ordenados por requestedAt DESC,
   * id DESC, paginados por CURSOR (keyset). ESPEJO EXACTO de listPassengerTrips pero filtrando por
   * `driverId` (id de PERFIL Driver de identity, NO userId — ver el invariante en driver-trips.service).
   * El driverId lo fija el BFF desde el JWT (anti-IDOR): este método NUNCA recibe el id del cliente.
   *
   * Mismo keyset (take = limit + 1 para el "peek" sin COUNT), mismo clamp del limit, mismo orden y mismo
   * anti-N+1 (el item NO trae el nombre del pasajero: la card muestra tier+ruta+monto+estado+fecha).
   */
  async listDriverTrips(
    driverId: string,
    rawCursor?: string,
    rawLimit?: number,
  ): Promise<TripHistoryPage> {
    const limit = clampLimit(rawLimit);
    const cursor = decodeCursor(rawCursor);
    // peek: 1 fila extra (limit + 1) para saber si hay siguiente página sin COUNT
    const rows = await this.repo.findHistoryPage(driverHistoryWhere(driverId, cursor), limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ requestedAt: last.requestedAt.toISOString(), id: last.id })
        : null;
    return { items: page.map((t) => tripToHistoryItem(t)), nextCursor };
  }

  /**
   * El viaje COMPLETED más antiguo del pasajero aún sin cerrar (passengerClosedAt null), o null. Es la
   * cola de "cierres pendientes" del post-viaje; `closeByPassenger` (TripsService) la va vaciando.
   */
  async getPendingSettlement(passengerId: string): Promise<TripView | null> {
    const trip = await this.repo.findOldestPendingSettlement(passengerId);
    return trip ? toTripView(trip) : null;
  }
}
