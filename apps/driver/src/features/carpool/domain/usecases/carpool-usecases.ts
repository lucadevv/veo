import type { CarpoolRepository } from '../repositories/carpool-repository';
import type {
  BookingRequest,
  BookingRequests,
  PublishTripInput,
  PublishedTrip,
  PublishedTrips,
  UpdateTripInput,
} from '../entities';

/** Caso de uso: listar mis ofertas de carpooling publicadas. */
export class GetMyTripsUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(): Promise<PublishedTrips> {
    return this.carpool.getMyTrips();
  }
}

/** Caso de uso: publicar una nueva oferta de carpooling. */
export class PublishTripUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(input: PublishTripInput): Promise<PublishedTrip> {
    return this.carpool.publishTrip(input);
  }
}

/** Caso de uso: editar una oferta PUBLICADA (patch parcial). */
export class UpdateTripUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(tripId: string, input: UpdateTripInput): Promise<PublishedTrip> {
    return this.carpool.updateTrip(tripId, input);
  }
}

/** Caso de uso: cancelar una de mis ofertas. */
export class CancelTripUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(tripId: string): Promise<PublishedTrip> {
    return this.carpool.cancelTrip(tripId);
  }
}

/** Caso de uso: listar las solicitudes entrantes de un viaje propio. */
export class GetTripBookingsUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(tripId: string): Promise<BookingRequests> {
    return this.carpool.getTripBookings(tripId);
  }
}

/** Caso de uso: aprobar una solicitud de reserva. */
export class ApproveBookingUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(bookingId: string): Promise<BookingRequest> {
    return this.carpool.approveBooking(bookingId);
  }
}

/** Caso de uso: rechazar una solicitud de reserva. */
export class RejectBookingUseCase {
  constructor(private readonly carpool: CarpoolRepository) {}

  execute(bookingId: string): Promise<BookingRequest> {
    return this.carpool.rejectBooking(bookingId);
  }
}
