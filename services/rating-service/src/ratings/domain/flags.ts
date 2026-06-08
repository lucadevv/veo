/**
 * Evaluación pura de flags por umbral (BR-D01 conductor, BR-I05 pasajero).
 * Sin I/O: testeable de forma aislada (incluye fronteras 4.3 y 4.0).
 */
import type { SubjectRole } from '../../generated/prisma';

/** Razón de flag emitida hacia el agregado y los eventos de dominio. */
export type FlagReason = 'review' | 'suspension' | 'reverification';

export interface FlagDecision {
  flagged: boolean;
  reason: FlagReason | null;
}

export interface FlagThresholds {
  /** BR-D01: por debajo de este promedio el conductor entra en "review". */
  driverReview: number;
  /** BR-D01: por debajo de este promedio el conductor entra en "suspension". */
  driverSuspension: number;
  /** BR-I05: por debajo de este promedio el pasajero requiere re-verificación. */
  passengerReverify: number;
}

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = {
  driverReview: 4.3,
  driverSuspension: 4.0,
  passengerReverify: 4.0,
};

const NO_FLAG: FlagDecision = { flagged: false, reason: null };

/**
 * BR-D01: rollingAvg < 4.0 → "suspension"; < 4.3 → "review"; en otro caso, sin flag.
 * No se evalúa con count === 0 (un sujeto sin calificaciones no se marca).
 */
export function evaluateDriverFlag(
  avg: number,
  count: number,
  thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS,
): FlagDecision {
  if (count <= 0) return NO_FLAG;
  if (avg < thresholds.driverSuspension) return { flagged: true, reason: 'suspension' };
  if (avg < thresholds.driverReview) return { flagged: true, reason: 'review' };
  return NO_FLAG;
}

/**
 * BR-I05: rollingAvg < 4.0 → "reverification"; en otro caso, sin flag.
 * No se evalúa con count === 0.
 */
export function evaluatePassengerFlag(
  avg: number,
  count: number,
  thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS,
): FlagDecision {
  if (count <= 0) return NO_FLAG;
  if (avg < thresholds.passengerReverify) return { flagged: true, reason: 'reverification' };
  return NO_FLAG;
}

/** Despacha la evaluación según el rol del sujeto calificado. */
export function evaluateFlag(
  role: SubjectRole,
  avg: number,
  count: number,
  thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS,
): FlagDecision {
  return role === 'DRIVER'
    ? evaluateDriverFlag(avg, count, thresholds)
    : evaluatePassengerFlag(avg, count, thresholds);
}
