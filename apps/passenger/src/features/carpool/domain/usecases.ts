import type {
  CarpoolBookingCreateRequest,
  CarpoolBookingView,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';
import type {
  CarpoolBrowseParams,
  CarpoolRepository,
  CarpoolSearchParams,
} from './carpoolRepository';

/** FEED del marketplace: todos los viajes futuros (filtro región opcional, página keyset). */
export class BrowseCarpoolTripsUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(params: CarpoolBrowseParams): Promise<CarpoolSearchPage> {
    return this.repository.browseTrips(params);
  }
}

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

/**
 * Cancela MI solicitud aún PENDIENTE (P/WaitingApproval · "Cancelar solicitud"). El server sella ownership +
 * estado (solo PENDIENTE_APROBACION); devuelve la reserva ya en CANCELADO. Sin cobro (charge-on-approval).
 */
export class CancelCarpoolBookingUseCase {
  constructor(private readonly repository: CarpoolRepository) {}

  execute(bookingId: string): Promise<CarpoolBookingView> {
    return this.repository.cancel(bookingId);
  }
}
