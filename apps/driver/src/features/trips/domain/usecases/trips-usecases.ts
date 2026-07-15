import type { GeoPoint, TripHistoryPage, TripHistoryQuery } from '@veo/api-client';
import type { TripsRepository } from '../repositories/trips-repository';
import type {
  CommissionRateView,
  CompleteTripInput,
  Trip,
  TripOffer,
  TripRouteView,
  TripState,
} from '../entities';
import { parseTripStatus } from '../value-objects/trip-status';

/** Error de validación del código del modo niño (4 a 6 dígitos). */
export class InvalidChildCodeError extends Error {
  constructor() {
    super('El código del modo niño debe tener de 4 a 6 dígitos');
    this.name = 'InvalidChildCodeError';
  }
}

const CHILD_CODE = /^\d{4,6}$/;

/** Caso de uso: leer la oferta/match entrante. */
export class GetOfferUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(matchId: string): Promise<TripOffer> {
    return this.trips.getOffer(matchId);
  }
}

/** Caso de uso: aceptar la oferta entrante (dispatch). */
export class AcceptOfferUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(matchId: string): Promise<void> {
    return this.trips.acceptOffer(matchId);
  }
}

/** Caso de uso: rechazar la oferta entrante (dispatch). */
export class RejectOfferUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(matchId: string): Promise<void> {
    return this.trips.rejectOffer(matchId);
  }
}

/** Caso de uso: obtener el viaje (lado conductor). */
export class GetTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string): Promise<Trip> {
    return this.trips.getTrip(tripId);
  }
}

/** Caso de uso: viaje activo del conductor (rehidratación tras reinicio). `null` si no tiene ninguno. */
export class GetActiveTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(): Promise<Trip | null> {
    return this.trips.getActiveTrip();
  }
}

/** Caso de uso: estado ligero del viaje. */
export class GetTripStateUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string): Promise<TripState> {
    return this.trips.getTripState(tripId);
  }
}

/**
 * Caso de uso: una página del HISTORIAL del conductor (cursor keyset). Devuelve `{ items, nextCursor }`;
 * el llamador re-pide con `nextCursor` hasta que sea `null`. El cursor es opaco (no se parsea).
 */
export class GetTripHistoryUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(query?: TripHistoryQuery): Promise<TripHistoryPage> {
    return this.trips.getTripHistory(query);
  }
}

/** Caso de uso: ruta + pasos de navegación turn-by-turn del viaje activo. */
export class GetTripRouteUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, from?: GeoPoint): Promise<TripRouteView> {
    return this.trips.getRoute(tripId, from);
  }
}

/** Caso de uso: confirmar la asignación del viaje (→ ACCEPTED). */
export class AcceptTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, etaSeconds?: number): Promise<Trip> {
    return this.trips.accept(tripId, { etaSeconds });
  }
}

/** Espera entre reintentos del poll de estado (inyectable para tests). */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureTripAcceptedOptions {
  /** ETA al recojo en segundos (si se conoce); se reenvía al endpoint de accept. */
  etaSeconds?: number;
  /** Nº máximo de sondeos del estado antes de rendirse (evita bloqueo infinito). */
  maxAttempts?: number;
  /** Espera entre sondeos mientras el viaje aún no está ASSIGNED. */
  intervalMs?: number;
}

/**
 * Caso de uso robusto: garantiza la transición ASSIGNED→ACCEPTED tras aceptar la oferta de dispatch.
 *
 * La máquina de estados exige ACCEPTED antes de ARRIVING, pero hay latencia entre
 * `dispatch.match_found` y `trip.assigned`: al llegar a la pantalla activa el viaje puede seguir en
 * REQUESTED/MATCHING. Por eso sondea el estado (poll corto y ACOTADO, sin bloqueo infinito) hasta
 * verlo ASSIGNED y entonces confirma la asignación. Es idempotente: si ya está ACCEPTED o más allá
 * (o terminó/canceló), no hace nada y devuelve `null`.
 */
export class EnsureTripAcceptedUseCase {
  constructor(
    private readonly trips: TripsRepository,
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  async execute(tripId: string, options: EnsureTripAcceptedOptions = {}): Promise<Trip | null> {
    const maxAttempts = options.maxAttempts ?? 8;
    const intervalMs = options.intervalMs ?? 750;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const state = await this.trips.getTripState(tripId);
      const status = parseTripStatus(state.status);

      if (status === 'ASSIGNED') {
        return this.trips.accept(tripId, { etaSeconds: options.etaSeconds });
      }

      // Aún sin asignar (latencia dispatch→trip): espera y reintenta.
      if (status === 'REQUESTED' || status === 'MATCHING') {
        if (attempt < maxAttempts - 1) {
          await this.sleep(intervalMs);
        }
        continue;
      }

      // Ya ACCEPTED/ARRIVING/… o terminado/cancelado/desconocido: nada que hacer (idempotente).
      return null;
    }

    // Se agotaron los reintentos sin ver ASSIGNED: no se bloquea, la UI puede reintentar/refrescar.
    return null;
  }
}

/** Caso de uso: marcar "en camino al recojo" (→ ARRIVING). */
export class ArrivingTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, etaSeconds?: number): Promise<Trip> {
    return this.trips.arriving(tripId, { etaSeconds });
  }
}

/** Caso de uso: marcar "en el punto de recojo" (→ ARRIVED). */
export class ArrivedTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string): Promise<Trip> {
    return this.trips.arrived(tripId);
  }
}

/**
 * Caso de uso: iniciar el viaje (→ IN_PROGRESS). Si el viaje es modo niño, exige el código
 * (lo verifica el adulto responsable; el conductor nunca lo conoce de antemano).
 */
export class StartTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, childCode?: string): Promise<Trip> {
    if (childCode !== undefined && !CHILD_CODE.test(childCode)) {
      throw new InvalidChildCodeError();
    }
    return this.trips.start(tripId, { childCode });
  }
}

/** Caso de uso: completar el viaje (→ COMPLETED). EFECTIVO: `input.cashCollected` confirma el cobro. */
export class CompleteTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, input?: CompleteTripInput): Promise<Trip> {
    return this.trips.complete(tripId, input);
  }
}

/**
 * Caso de uso: confirmar el cobro en EFECTIVO tras completar el viaje (decisión del dueño). `collected=true`
 * captura el cobro CASH; `false` reporta que no se cobró (discrepancia). El paymentId lo resuelve el BFF.
 */
export class ConfirmTripCashUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, collected: boolean): Promise<void> {
    return this.trips.confirmCash(tripId, collected);
  }
}

/** Caso de uso: cancelar el viaje (actor DRIVER fijado en el BFF). */
export class CancelTripUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(tripId: string, reason?: string): Promise<Trip> {
    return this.trips.cancel(tripId, { reason });
  }
}

/** Caso de uso: tasa de comisión ON-DEMAND vigente (panel admin, vía driver-bff). */
export class GetCommissionRateUseCase {
  constructor(private readonly trips: TripsRepository) {}
  execute(): Promise<CommissionRateView> {
    return this.trips.getCommissionRate();
  }
}
