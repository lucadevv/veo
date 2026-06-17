import type { EarningsBreakdown, EarningsPeriodBreakdown } from '../entities';

/**
 * Neto esperado de un período según el modelo de negocio VEO: bruto − comisión + propinas.
 * (Las propinas van 100% al conductor, fuera de comisión — BR-P04.) Útil para verificar coherencia
 * del desglose que llega del backend o reconstruir el neto si hiciera falta.
 */
export function expectedNetCents(b: EarningsPeriodBreakdown): number {
  return b.grossCents - b.commissionCents + b.tipCents;
}

/** `true` si el `netCents` reportado coincide con `bruto − comisión + propinas`. */
export function isBreakdownConsistent(b: EarningsPeriodBreakdown): boolean {
  return expectedNetCents(b) === b.netCents;
}

/** Comisión efectiva como fracción del bruto (0 si el bruto es 0). Para mostrar "% comisión". */
export function commissionRate(b: EarningsPeriodBreakdown): number {
  if (b.grossCents <= 0) {
    return 0;
  }
  return b.commissionCents / b.grossCents;
}

/** Aplana el desglose en pares etiqueta-clave/valor (céntimos) para render denso o pruebas. */
export interface BreakdownLineItem {
  key: 'gross' | 'commission' | 'tips' | 'net';
  cents: number;
}

/** Devuelve las líneas del desglose en orden de lectura: bruto, comisión, propinas, neto. */
export function breakdownLines(b: EarningsPeriodBreakdown): BreakdownLineItem[] {
  return [
    { key: 'gross', cents: b.grossCents },
    { key: 'commission', cents: b.commissionCents },
    { key: 'tips', cents: b.tipCents },
    { key: 'net', cents: b.netCents },
  ];
}

/** Suma los netos de HOY y SEMANA no tiene sentido (se solapan); helper para el neto de la semana. */
export function weekNetCents(summary: EarningsBreakdown): number {
  return summary.week.netCents;
}
