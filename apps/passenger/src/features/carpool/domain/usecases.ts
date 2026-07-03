import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';
import type {CarpoolRepository, CarpoolSearchParams} from './carpoolRepository';

/** Busca viajes publicados que calcen ruta + fecha + asientos (página keyset). */
export class SearchCarpoolTripsUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(params: CarpoolSearchParams): Promise<CarpoolSearchPage> {
    return this.repository.searchTrips(params);
  }
}

/** Detalle enriquecido de un viaje publicado (driver/vehicle nullable: degradación honesta). */
export class GetCarpoolTripDetailUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(tripId: string): Promise<CarpoolTripDetail> {
    return this.repository.getTripDetail(tripId);
  }
}

/**
 * Solicita la reserva de asiento(s). La `idempotencyKey` (UUID por submit) la genera el CALLER y
 * dedupea el reintento del MISMO submit server-side — un submit nuevo lleva key nueva.
 */
export class ReserveCarpoolSeatUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(
    request: CarpoolBookingCreateRequest,
    idempotencyKey: string,
  ): Promise<CarpoolBookingView> {
    return this.repository.reserve(request, idempotencyKey);
  }
}

/** MI reserva por id — fuente del POLL de la pantalla de estado (aprobación del conductor). */
export class GetCarpoolBookingUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(bookingId: string): Promise<CarpoolBookingView> {
    return this.repository.getBooking(bookingId);
  }
}
