/**
 * Políticas puras de liquidación (payouts). Sin I/O.
 * Agrega los cobros capturados de un conductor en un período y decide si supera el mínimo (BR-P05).
 * Incluye la máquina de estados del payout (espejo de PAYMENT_TRANSITIONS en payment.policy).
 */
import { InvalidStateError } from '@veo/utils';
import type { PayoutStatus } from '@veo/shared-types';

export interface DriverEarningRow {
  driverId: string;
  grossCents: number;
  commissionCents: number;
  tipCents: number;
  /**
   * F2.3 · Compensación NETA al conductor fuera de la tarifa (penalidad de cancelación COLLECTED). No es
   * bruto de viaje ni lleva comisión: entra DIRECTO al neto (como la propina), sin inflar `grossCents`.
   * Ausente/0 en las filas de cobro normales.
   */
  compensationCents?: number;
  /**
   * Bono de incentivo del conductor (IncentiveProgress.rewardGrantedCents) liquidado en este período.
   * Es un crédito NETO fuera de la tarifa (no es bruto de viaje ni lleva comisión): entra DIRECTO al
   * neto, como la propina y la compensación. Campo PROPIO (no se mezcla con compensationCents) para
   * trazabilidad contable. Ausente/0 en las filas de cobro normales.
   */
  incentiveCents?: number;
}

export interface AggregatedPayout {
  driverId: string;
  grossCents: number;
  commissionCents: number;
  /** Neto a pagar = (bruto − comisión) + propinas. */
  amountCents: number;
}

/**
 * Agrega filas de ganancia por conductor y filtra las que no alcanzan el mínimo liquidable.
 * Determinista y ordenado por driverId para reproducibilidad del cron.
 */
export function aggregatePayouts(rows: DriverEarningRow[], minCents: number): AggregatedPayout[] {
  const byDriver = new Map<string, AggregatedPayout>();
  for (const row of rows) {
    const acc = byDriver.get(row.driverId) ?? {
      driverId: row.driverId,
      grossCents: 0,
      commissionCents: 0,
      amountCents: 0,
    };
    acc.grossCents += row.grossCents;
    acc.commissionCents += row.commissionCents;
    // Neto = (bruto − comisión) + propinas + compensación de penalidad + bono de incentivo. Compensación
    // y bono entran NETOS (sin comisión ni bruto): no inflan grossCents/commissionCents, igual que la propina.
    acc.amountCents +=
      row.grossCents - row.commissionCents + row.tipCents + (row.compensationCents ?? 0) + (row.incentiveCents ?? 0);
    byDriver.set(row.driverId, acc);
  }
  return [...byDriver.values()]
    .filter((p) => p.amountCents >= minCents)
    .sort((a, b) => a.driverId.localeCompare(b.driverId));
}

/** Etiqueta de período ISO (YYYY-MM-DD/YYYY-MM-DD) para el evento payout.processed. */
export function periodLabel(start: Date, end: Date): string {
  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  return `${fmt(start)}/${fmt(end)}`;
}

/**
 * Transiciones válidas de la máquina de estados del payout (BR-P05). Mapa TIPADO y exhaustivo
 * (Record<PayoutStatus, ...>): agregar un estado al enum obliga a declarar sus transiciones.
 *  - HELD → PROCESSED es el camino de VUELTA de driver.flagged: la retención se libera cuando el
 *    review del conductor se resuelve (acción admin), nunca en silencio.
 */
const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  PENDING: ['PROCESSING', 'PROCESSED', 'HELD', 'FAILED'],
  PROCESSING: ['PROCESSED', 'FAILED'],
  // La retención se LIBERA (review resuelto) → se procesa. No vuelve a PENDING: liberar = pagar.
  HELD: ['PROCESSED'],
  // Un payout fallido puede reintentarse (transferencia caída) hasta procesarse.
  FAILED: ['PROCESSING', 'PROCESSED'],
  PROCESSED: [],
};

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  if (from === to) return true;
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransitionPayout(from, to)) {
    throw new InvalidStateError(`Transición de payout inválida: ${from} → ${to}`);
  }
}

/** Discrepancia (0..1) entre lo capturado en DB y el extracto del gateway (BR-P07). */
export function discrepancyPct(dbTotalCents: number, statementTotalCents: number): number {
  if (dbTotalCents === 0 && statementTotalCents === 0) return 0;
  const base = Math.max(Math.abs(dbTotalCents), 1);
  return Math.abs(dbTotalCents - statementTotalCents) / base;
}
