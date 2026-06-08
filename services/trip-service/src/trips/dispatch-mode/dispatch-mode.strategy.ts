/**
 * DispatchModeStrategy (ADR 010/011) — puerto que encapsula la VARIACIÓN de comportamiento por modo de
 * despacho (PUJA bidding / FIXED precio fijo). Hace el sistema OPEN/CLOSED: un modo nuevo se agrega
 * implementando esta interfaz + registrándola en DispatchModeRegistry, SIN tocar createTrip / reassign /
 * activateScheduledTrip con if/else. La DECISIÓN de qué modo (resolveMode) sigue en domain/pricing-mode.
 *
 * Hoy captura `openDispatch` (qué evento de apertura emite cada modo); `resolveCreation` (tarifa+seq) y
 * `reassign` se incorporan en lotes siguientes (la firma se extiende, no se rompe).
 */
import type { LatLon } from '@veo/utils';
import type { PricingMode } from '@veo/shared-types';
import type { Prisma, Trip } from '../../generated/prisma';

type TxClient = Prisma.TransactionClient;

/** Contexto de la apertura del despacho. `scheduled` = la apertura nace de activar una reserva (cron). */
export interface DispatchOpenContext {
  scheduled: boolean;
}

export interface DispatchModeStrategy {
  /** El modo que esta estrategia atiende (clave del registry). */
  readonly mode: PricingMode;

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
}
