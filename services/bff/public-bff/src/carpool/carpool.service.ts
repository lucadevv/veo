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
 * FUERA DE ALCANCE (gaps del downstream, honestos): "mis reservas" (GET /bookings/mine · F1) y CANCELAR la
 * solicitud (F3c · refund por tier) aún no existen en booking-service — cuando lleguen, se proxyan acá.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';
import { REST_BOOKING } from '../infra/downstream.tokens';
import type { SearchCarpoolTripsDto } from './dto/carpool.dto';

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
        limit: dto.limit,
        cursor: dto.cursor,
      },
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
}
