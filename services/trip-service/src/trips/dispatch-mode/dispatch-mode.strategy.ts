/**
 * DispatchModeStrategy (ADR 010/011/023) — puerto que encapsula la VARIACIÓN de comportamiento por modo de
 * despacho (PUJA bidding / FIXED precio fijo). Hace el sistema OPEN/CLOSED: un modo nuevo se agrega
 * implementando esta interfaz + registrándola en DispatchModeRegistry, SIN tocar createTrip / reassign /
 * activateScheduledTrip con if/else. La DECISIÓN de qué modo la da la OFERTA (ADR 023 `effectiveOfferingMode`).
 *
 * Hoy captura `openDispatch` (qué evento de apertura emite cada modo); `resolveCreation` (tarifa+seq) y
 * `reassign` se incorporan en lotes siguientes (la firma se extiende, no se rompe).
 */
import type { LatLon } from '@veo/utils';
import type { OfferingPricingPolicy, PricingMode } from '@veo/shared-types';
import type { Prisma, Trip } from '../../generated/prisma';

type TxClient = Prisma.TransactionClient;

/** Contexto de la apertura del despacho. `scheduled` = la apertura nace de activar una reserva (cron). */
export interface DispatchOpenContext {
  scheduled: boolean;
}

/** Insumos para fijar la tarifa al crear el viaje (el modo usa los que necesita). */
export interface DispatchCreationInput {
  /** Oferta del pasajero (solo PUJA la usa; FIXED la ignora). */
  bidCents?: number;
  /** Piso del bid resuelto por zona (solo PUJA lo usa). */
  floorCents: number;
  /** Ruta para el cálculo de tarifa fija (solo FIXED la usa). */
  route: { distanceMeters: number; durationSeconds: number };
  surge: number;
  childMode: boolean;
  /**
   * F2.4 · tarifa base configurable por el admin (`BaseFareConfig`, céntimos PEN). Solo FIXED la usa; default
   * = las constantes de código (retro-compat). El triple se resuelve en `createTrip` y viaja a la fórmula.
   */
  baseFareCents?: number;
  perKmCents?: number;
  perMinCents?: number;
  /**
   * ADR 013 §1.7 · política de pricing de la OFERTA (del catálogo de @veo/shared-types, fuente única —
   * NO se duplica la tabla acá). FIXED la APLICA a la tarifa firme: max(round(calculateFare ×
   * multiplier), minFareCents). PUJA la IGNORA (el bid ES la tarifa; el multiplier solo afecta el
   * suggestedCents del quote, que ya lo aplica el BFF).
   */
  pricing: OfferingPricingPolicy;
}

/** Resultado de fijar la creación: la tarifa firme + el seq inicial de negociación. */
export interface DispatchCreation {
  fareCents: number;
  /** PUJA abre el 1er ciclo de negociación (1); FIXED no negocia (0). */
  negotiationSeq: number;
}

export interface DispatchModeStrategy {
  /** El modo que esta estrategia atiende (clave del registry). */
  readonly mode: PricingMode;

  /**
   * Fija la TARIFA y el negotiationSeq inicial según el modo. PUJA: valida el bid (piso ≤ bid ≤ techo) y
   * el bid ES el fareCents; FIXED: calcula la tarifa firme por ruta (calculateFare). Lanza ValidationError
   * si el bid falta o está fuera de rango (PUJA). Es PURA (sin I/O): el caller arma el input.
   */
  resolveCreation(input: DispatchCreationInput): DispatchCreation;

  /**
   * Emite el evento de APERTURA del despacho en la transacción del caller (mismo outbox que la mutación
   * de dominio). PUJA → trip.bid_posted (abre el OfferBoard); FIXED → trip.requested (matching secuencial).
   */
  openDispatch(
    tx: TxClient,
    trip: Trip,
    origin: LatLon,
    destination: LatLon,
    ctx: DispatchOpenContext,
  ): Promise<void>;

  /**
   * Reasignación tras la cancelación del conductor post-accept (driver-cancel). Escribe el DELTA del modo
   * en la TX del caller (el service ya hizo `assertTransition(REASSIGNING)` + el guard de tope→FAILED,
   * ambos TRANSVERSALES) y emite el evento de re-despacho. Devuelve la fila actualizada.
   *
   *  - PUJA: re-abre el OfferBoard → REASSIGNING + driverId null + reset H12 (agreedFareCents=null) + bump
   *    H13 (negotiationSeq+1) — TODO en el MISMO update (atómico) — + `trip.reassigning` ENRIQUECIDO.
   *  - FIXED: REASSIGNING + driverId null + re-emite `trip.requested`; NO toca negotiationSeq/agreedFareCents.
   */
  reassign(tx: TxClient, trip: Trip, nextReassignCount: number, reason?: string): Promise<Trip>;
}
