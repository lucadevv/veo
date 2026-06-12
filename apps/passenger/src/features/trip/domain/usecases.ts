import type {
  CreateTripRequest,
  CreatedShareLink,
  GeoPoint,
  OfferList,
  OfferView,
  RevokedShareLink,
  ScheduledTripList,
  ShareTripRequest,
  SurgeQuote,
  TripActiveView,
  TripHistoryPage,
  TripHistoryQuery,
  TripResource,
  TripVideoGrant,
} from '@veo/api-client';
import { isValidChildCode } from '../../childMode/domain/entities';
import { isWithinLima } from '../../../shared/utils/geo';
import { validateScheduledFor } from './scheduling';
import type { TripRepository } from './tripRepository';

/** Error de dominio para entradas inválidas de viaje (origen/destino/código/programación). */
export class TripValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'OUTSIDE_LIMA'
      | 'INVALID_CHILD_CODE'
      | 'SCHEDULE_TOO_SOON'
      | 'SCHEDULE_TOO_FAR'
      | 'SCHEDULE_INVALID'
      | 'INVALID_BID',
  ) {
    super(message);
    this.name = 'TripValidationError';
  }
}

/** Obtiene el multiplicador de surge para estimar la tarifa antes de confirmar. */
export class GetSurgeUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(coords: GeoPoint): Promise<SurgeQuote> {
    return this.repository.getSurge(coords);
  }
}

/**
 * Viaje ACTIVO (vivo) del pasajero SIN conocer el id — fuente de verdad para REHIDRATAR el flujo
 * unificado al (re)entrar (el sheet vuelve al estado real) y para el banner cross-tab. Devuelve `null`
 * si no hay ninguno (el pasajero está en el home, sin viaje en curso).
 */
export class GetMyActiveTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(): Promise<TripActiveView | null> {
    return this.repository.getMyActiveTrip();
  }
}

/**
 * Cierre post-viaje PENDIENTE (último COMPLETED sin cerrar) SIN conocer su id — re-entrada del cierre
 * tras un reload, cuando `GET /trips/active` ya no devuelve el COMPLETED (terminal). Devuelve `null`
 * si no hay ninguno. La pantalla adopta el id en el `activeTripStore` para re-ofrecer recibo + rating.
 */
export class GetPendingSettlementUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(): Promise<TripActiveView | null> {
    return this.repository.getPendingSettlement();
  }
}

/**
 * Cierra el post-viaje de un viaje COMPLETED (`POST /trips/:id/close`, BR re-entrada). IDEMPOTENTE:
 * cerrar dos veces es ok. NO cambia el estado del viaje (sigue COMPLETED); marca `passengerClosedAt`
 * server-side para que deje de aparecer en pending-settlement. La app lo llama al terminar el cierre.
 */
export class CloseTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string): Promise<TripActiveView> {
    return this.repository.closeTrip(tripId);
  }
}

/**
 * Crea/cotiza el viaje. Valida reglas de dominio antes de tocar la red (SRP):
 *  - origen y destino dentro de Lima Metropolitana (zona operativa).
 *  - paradas intermedias (Ola 2B) también dentro de Lima.
 *  - si hay modo niño, el código debe cumplir el patrón 4-6 dígitos.
 *  - si es programado (Ola 2B), la fecha cae en la ventana [≥15min, ≤7días].
 */
export class CreateTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(input: CreateTripRequest, idempotencyKey?: string): Promise<TripResource> {
    if (!isWithinLima(input.origin) || !isWithinLima(input.destination)) {
      throw new TripValidationError('Fuera de Lima Metropolitana', 'OUTSIDE_LIMA');
    }
    if (input.waypoints?.some((stop) => !isWithinLima(stop))) {
      throw new TripValidationError('Fuera de Lima Metropolitana', 'OUTSIDE_LIMA');
    }
    if (input.childMode && input.childCode && !isValidChildCode(input.childCode)) {
      throw new TripValidationError('Código de modo niño inválido', 'INVALID_CHILD_CODE');
    }
    if (input.scheduledFor !== undefined) {
      const verdict = validateScheduledFor(new Date(input.scheduledFor));
      if (!verdict.valid) {
        const code =
          verdict.reason === 'TOO_SOON'
            ? 'SCHEDULE_TOO_SOON'
            : verdict.reason === 'TOO_FAR'
              ? 'SCHEDULE_TOO_FAR'
              : 'SCHEDULE_INVALID';
        throw new TripValidationError('Programación inválida', code);
      }
    }
    // IK · la key de idempotencia (una por INTENTO de confirmación) dedupea reintentos server-side.
    return this.repository.createTrip(input, idempotencyKey);
  }
}

/** Cancela el viaje (motivo opcional). */
export class CancelTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string, reason?: string): Promise<TripResource> {
    return this.repository.cancelTrip(tripId, reason ? { reason } : {});
  }
}

/** Cambia el destino del viaje en curso (debe estar dentro de Lima). */
export class ChangeDestinationUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string, destination: GeoPoint): Promise<TripResource> {
    if (!isWithinLima(destination)) {
      throw new TripValidationError('Fuera de Lima Metropolitana', 'OUTSIDE_LIMA');
    }
    return this.repository.changeDestination(tripId, destination);
  }
}

/**
 * Obtiene el token viewer del habitáculo. El bff responde 403/404 cuando no hay video (LiveKit no
 * configurado o viaje no IN_PROGRESS): el llamador degrada a "sin video" (no se inventan credenciales).
 */
export class GetCabinVideoUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string): Promise<TripVideoGrant> {
    return this.repository.getVideoGrant(tripId);
  }
}

/** Lista los viajes PROGRAMADOS (estado SCHEDULED) del pasajero, ordenados por hora ascendente. */
export class ListScheduledTripsUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(): Promise<ScheduledTripList> {
    return this.repository.listScheduledTrips();
  }
}

/**
 * Una PÁGINA del HISTORIAL de viajes del pasajero (`GET /trips/history`), con sus ESTADOS REALES del
 * servidor (COMPLETED/CANCELLED/EXPIRED/FAILED…). Paginación por CURSOR: el llamador re-pasa el
 * `nextCursor` de la página previa hasta que sea `null`. Esta es la FUENTE DE VERDAD del historial —
 * reemplaza la foto local de MMKV (que mostraba todo "Solicitado" porque nunca se actualizaba).
 */
export class GetTripHistoryUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(query?: TripHistoryQuery): Promise<TripHistoryPage> {
    return this.repository.getTripHistory(query);
  }
}

/** Cancela un viaje programado (DELETE /trips/:id/schedule). Sin penalidad si es con antelación. */
export class CancelScheduledTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string): Promise<void> {
    return this.repository.cancelScheduledTrip(tripId);
  }
}

/**
 * Crea un enlace público de seguimiento del viaje EN CURSO para compartir con la familia
 * (POST /share/:tripId). Devuelve el enlace recién creado: la presentación toma `url` para
 * abrir la hoja nativa de compartir y `token`/`expiresAt` para revocar o mostrar la caducidad.
 * Los campos del request (contacto, TTL, máximo de aperturas) son opcionales: el bff aplica
 * sus defaults cuando se omiten.
 */
export class ShareTripUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string, input?: ShareTripRequest): Promise<CreatedShareLink> {
    return this.repository.shareTrip(tripId, input);
  }
}

/**
 * Revoca el enlace de seguimiento de la sesión actual (POST /share/:shareId/revoke). Kill-switch
 * del pasajero: la página pública deja de servir la ubicación al instante. Idempotente en el server
 * (revocar un enlace ya revocado devuelve su `revokedAt` original sin error). La presentación toma
 * `revokedAt` solo como confirmación; el efecto real es server-authoritative.
 */
export class RevokeShareUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(shareId: string): Promise<RevokedShareLink> {
    return this.repository.revokeShare(shareId);
  }
}

// ── PUJA (ADR 010) · negociación del board ────────────────────────────────────────────────────

/** Lista las ofertas del board del pasajero (conductores que aceptaron tu bid o contraofertaron). */
export class ListOffersUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string): Promise<OfferList> {
    return this.repository.listOffers(tripId);
  }
}

/**
 * El pasajero ELIGE una oferta del board (por `driverId`) → match. Idempotente downstream. La UI solo
 * habilita ofertas válidas; el gate de ownership + estado lo aplica el servidor (la UI refleja, no autoriza).
 */
export class AcceptOfferUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string, driverId: string): Promise<OfferView> {
    return this.repository.acceptOffer(tripId, driverId);
  }
}

/** El pasajero cancela su puja (cierra el board). Idempotente. */
export class CancelBidUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string): Promise<void> {
    return this.repository.cancelBid(tripId);
  }
}

/**
 * Re-puja: re-abre el board con una nueva tarifa (desde EXPIRED tras una puja sin ofertas, o desde
 * REASSIGNING tras la cancelación del conductor). Valida que el monto sea un entero positivo en céntimos;
 * el PISO de zona y el estado válido los re-valida el servidor (autoritativo; la UI refleja el piso).
 */
export class RebidUseCase {
  constructor(private readonly repository: TripRepository) {}

  execute(tripId: string, bidCents: number): Promise<TripResource> {
    if (!Number.isInteger(bidCents) || bidCents <= 0) {
      throw new TripValidationError('Oferta inválida', 'INVALID_BID');
    }
    return this.repository.rebid(tripId, bidCents);
  }
}
