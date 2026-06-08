/**
 * Políticas puras de liquidación (payouts). Sin I/O.
 * Agrega los cobros capturados de un conductor en un período y decide si supera el mínimo (BR-P05).
 */
export interface DriverEarningRow {
  driverId: string;
  grossCents: number;
  commissionCents: number;
  tipCents: number;
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
    acc.amountCents += row.grossCents - row.commissionCents + row.tipCents;
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

/** Discrepancia (0..1) entre lo capturado en DB y el extracto del gateway (BR-P07). */
export function discrepancyPct(dbTotalCents: number, statementTotalCents: number): number {
  if (dbTotalCents === 0 && statementTotalCents === 0) return 0;
  const base = Math.max(Math.abs(dbTotalCents), 1);
  return Math.abs(dbTotalCents - statementTotalCents) / base;
}
