/**
 * Carpooling del PASAJERO (ADR-014 · design/veo.pen sección 5). Proxy firmado a booking-service de las 4
 * operaciones del pasajero: BUSCAR viajes publicados (ruta+fecha+asientos), ver el DETALLE enriquecido
 * (conductor/vehículo públicos), SOLICITAR la reserva de asiento(s) y SEGUIR el estado de SU reserva
 * (PENDIENTE_APROBACION → APROBADO/RECHAZADO/…). El BFF no reimplementa lógica: valida en el borde y delega.
 *
 * ANTI-IDOR (mismo patrón que support/payments): el `passengerId` NUNCA viaja en el body/path — booking-service
 * lo toma de la identidad firmada que este BFF propaga (public-rail) y scopea la reserva a su dueño (ajena →
 * 404, sin filtrar existencia).
 *
 * F3c-passenger (este lote): CANCELAR la propia solicitud aún PENDIENTE (POST /bookings/:id/cancel · public-
 * rail). Se proxya firmado igual que reserve/getBooking; el downstream sella ownership + estado (solo
 * PENDIENTE_APROBACION) server-truth. La cancelación CON-TIER tras el cobro (refund) es OTRA fase (F3/F5).
 *
 * FUERA DE ALCANCE (gaps del downstream, honestos): "mis reservas" (GET /bookings/mine · F1) aún no existe en
 * booking-service — cuando llegue, se proxya acá.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolPopularRoutes,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';
import { REST_BOOKING } from '../infra/downstream.tokens';
import type { BrowseCarpoolTripsDto, SearchCarpoolTripsDto } from './dto/carpool.dto';

@Injectable()
export class CarpoolService {
  constructor(@Inject(REST_BOOKING) private readonly bookingRest: InternalRestClient) {}

  /** GET /published-trips/search — página keyset de viajes publicados que calzan ruta+fecha+asientos. */
  search(user: AuthenticatedUser, dto: SearchCarpoolTripsDto): Promise<CarpoolSearchPage> {
    return this.bookingRest.get<CarpoolSearchPage>('/published-trips/search', {
      identity: user,
      query: {
        originLat: dto.originLat,
        originLon: dto.originLon,
        destLat: dto.destLat,
        destLon: dto.destLon,
        fecha: dto.fecha,
        asientos: dto.asientos,
        // Orden + filtros opcionales (F2b): el downstream aplica defaults/semántica (Lima, tope, keyset).
        orden: dto.orden,
        precioMaxCents: dto.precioMaxCents,
        salidaDesde: dto.salidaDesde,
        salidaHasta: dto.salidaHasta,
        limit: dto.limit,
        cursor: dto.cursor,
      },
    });
  }

  /**
   * GET /published-trips/browse — FEED del marketplace (todos los viajes publicados futuros, sin ruta ni
   * fecha), filtros opcionales por región ORIGEN (`region`) y región DESTINO (`destRegion`) del catálogo
   * compartido — independientes entre sí. Misma página keyset que search.
   */
  browse(user: AuthenticatedUser, dto: BrowseCarpoolTripsDto): Promise<CarpoolSearchPage> {
    return this.bookingRest.get<CarpoolSearchPage>('/published-trips/browse', {
      identity: user,
      query: {
        region: dto.region,
        destRegion: dto.destRegion,
        orden: dto.orden,
        precioMaxCents: dto.precioMaxCents,
        limit: dto.limit,
        cursor: dto.cursor,
      },
    });
  }

  /**
   * GET /published-trips/popular-routes — top-N de pares región→región con viajes ofertables (agregado de
   * DISPLAY del downstream: sin conductores, sin cursor). Sin params: el downstream decide cap y orden.
   */
  popularRoutes(user: AuthenticatedUser): Promise<CarpoolPopularRoutes> {
    return this.bookingRest.get<CarpoolPopularRoutes>('/published-trips/popular-routes', {
      identity: user,
    });
  }

  /** GET /published-trips/:id — detalle ENRIQUECIDO (viaje público + conductor + vehículo públicos). */
  getDetail(user: AuthenticatedUser, id: string): Promise<CarpoolTripDetail> {
    return this.bookingRest.get<CarpoolTripDetail>(`/published-trips/${id}`, {
      identity: user,
    });
  }

  /**
   * POST /bookings — solicita la reserva. `Idempotency-Key` (UUID por intento de submit) deduplica el
   * REINTENTO del mismo submit sin bloquear una reserva nueva (misma semántica que el downstream).
   */
  reserve(
    user: AuthenticatedUser,
    dto: CarpoolBookingCreateRequest,
    idempotencyKey?: string,
  ): Promise<CarpoolBookingView> {
    return this.bookingRest.post<CarpoolBookingView>('/bookings', {
      identity: user,
      body: dto,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /** GET /bookings/:id — MI reserva (scoped server-truth al dueño; ajena → 404). */
  getBooking(user: AuthenticatedUser, id: string): Promise<CarpoolBookingView> {
    return this.bookingRest.get<CarpoolBookingView>(`/bookings/${id}`, {
      identity: user,
    });
  }

  /**
   * POST /bookings/:id/cancel — cancela MI solicitud aún PENDIENTE (sin body). El downstream toma el
   * passengerId de la identidad firmada (server-truth) y sella ownership + estado (solo PENDIENTE_APROBACION);
   * ajena/inexistente → 404, ya resuelta → 409. Sin cobro ni refund (charge-on-approval: nunca se aprobó).
   */
  cancelBooking(user: AuthenticatedUser, id: string): Promise<CarpoolBookingView> {
    return this.bookingRest.post<CarpoolBookingView>(`/bookings/${id}/cancel`, {
      identity: user,
    });
  }
}
