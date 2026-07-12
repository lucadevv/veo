import {tripStatus, type TripStatus} from '@veo/api-client';

/**
 * FASE del flujo de viaje unificado: la única fuente de verdad de "qué muestra el sheet sobre el mapa
 * persistente", derivada del estado del viaje. Reemplaza los `useEffect` de navegación que duplicaban
 * el mapa estados→pantalla en las pantallas de viaje legacy (patrón State + SRP: la UI REFLEJA la fase,
 * no decide a dónde navegar).
 *
 *  idle        → sin destino elegido (home: buscador + atajos)
 *  quoting     → destino elegido, sin viaje creado (cotización / "ofrecé tu tarifa" PUJA)
 *  searching   → viaje creado, puja abierta SIN ofertas todavía ("buscando conductores")
 *  offers      → puja abierta CON ≥1 oferta (el pasajero elige)
 *  noOffers    → la puja expiró sin match (re-pujar más alto)        [Lote 3]
 *  reassigning → el conductor asignado canceló; se reabre el board   [Lote 3]
 *  enRoute     → conductor asignado/aceptó/en camino al recojo       [Lote 2]
 *  arrived     → el conductor llegó al punto de recojo               [Lote 2]
 *  inProgress  → viaje en curso                                      [Lote 2]
 *  completed   → viaje completado (pagar + calificar en el sheet)    [Lote 3]
 *  ended       → cancelado / falló (terminal → volver al home)       [Lote 3]
 */
export type TripPhase =
  | 'idle'
  | 'quoting'
  | 'searching'
  | 'offers'
  | 'noOffers'
  | 'reassigning'
  | 'enRoute'
  | 'arrived'
  | 'inProgress'
  | 'completed'
  | 'ended';

/**
 * `status` viene de `live.status ?? trip.status`. El parámetro acepta `string` además de `TripStatus`
 * porque el status puede llegar CRUDO (sin pasar por `normalizeTripStatus`) del socket/REST — un valor
 * fuera del contrato cae al `default`. Las comparaciones usan `tripStatus.enum.*` (no literales sueltos).
 */
export interface TripPhaseInput {
  /** Hay destino fijado en el borrador (origen siempre se siembra con la ubicación). */
  hasDestination: boolean;
  /** Id del viaje YA creado (null hasta confirmar el pedido). */
  activeTripId: string | null;
  /** Estado efectivo del viaje (socket o REST). */
  status: TripStatus | string | null;
  /** Ofertas vivas en el board (para distinguir "buscando" de "hay ofertas"). */
  offerCount: number;
}

/** Deriva la fase del flujo. PURA (sin efectos) → fácil de testear y razonar. */
export function resolveTripPhase({
  hasDestination,
  activeTripId,
  status,
  offerCount,
}: TripPhaseInput): TripPhase {
  // Sin viaje creado: home (idle) o cotización (destino elegido).
  if (!activeTripId) {
    return hasDestination ? 'quoting' : 'idle';
  }
  switch (status) {
    case tripStatus.enum.REQUESTED:
    case tripStatus.enum.MATCHING:
      return offerCount > 0 ? 'offers' : 'searching';
    case tripStatus.enum.EXPIRED:
      return 'noOffers';
    case tripStatus.enum.REASSIGNING:
      return 'reassigning';
    case tripStatus.enum.ASSIGNED:
    case tripStatus.enum.ACCEPTED:
    case tripStatus.enum.ARRIVING:
      return 'enRoute';
    case tripStatus.enum.ARRIVED:
      return 'arrived';
    case tripStatus.enum.IN_PROGRESS:
      return 'inProgress';
    case tripStatus.enum.COMPLETED:
      return 'completed';
    case tripStatus.enum.CANCELLED:
    case tripStatus.enum.FAILED:
      return 'ended';
    default:
      // Estado desconocido con viaje activo: lo más seguro es "buscando" (puja recién abierta).
      return 'searching';
  }
}

/**
 * ¿Esta fase justifica MANTENER ABIERTO el socket `/passenger`? Solo las fases con un viaje VIVO al que
 * el conductor emite (driver:location/eta/trip:update) o donde corre la PUJA (offers entrantes / chat):
 *   searching · offers · noOffers · reassigning · enRoute · arrived · inProgress.
 * En `idle`/`quoting` no hay viaje; en `completed`/`ended` el viaje terminó y el gateway del BFF RECHAZA
 * el handshake ("el viaje no está activo") en loop —el recibo se refresca por poll REST, no por socket—.
 * Gatear con esto evita ese loop en la re-entrada al cierre (settlement de un trip COMPLETED).
 */
export function isLiveSocketPhase(phase: TripPhase): boolean {
  switch (phase) {
    case 'searching':
    case 'offers':
    case 'noOffers':
    case 'reassigning':
    case 'enRoute':
    case 'arrived':
    case 'inProgress':
      return true;
    case 'idle':
    case 'quoting':
    case 'completed':
    case 'ended':
      return false;
    default:
      return false;
  }
}

/** Modo del mapa por fase (el AppMap persistente reacciona a esto). */
export type MapMode = 'idle' | 'route' | 'trip';

/** Mapea la fase al modo del mapa (idle=pin / route=ruta dibujada / trip=auto en vivo). */
export function mapModeForPhase(phase: TripPhase): MapMode {
  switch (phase) {
    case 'idle':
      return 'idle';
    case 'quoting':
    case 'searching':
    case 'offers':
    case 'noOffers':
    case 'reassigning':
      return 'route';
    case 'enRoute':
    case 'arrived':
    case 'inProgress':
    case 'completed':
      return 'trip';
    case 'ended':
      return 'idle';
    default:
      return 'idle';
  }
}
