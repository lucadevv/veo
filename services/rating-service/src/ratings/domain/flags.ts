/**
 * Evaluación pura de flags por umbral (BR-D01 conductor, BR-I05 pasajero).
 * Sin I/O: testeable de forma aislada (incluye fronteras 4.3 y 4.0).
 */
import { FLAG_REASON, type FlagReason } from '@veo/events';
import type { SubjectRole } from '../../generated/prisma';

/**
 * Razones de flag — el VALOR canónico vive en el CONTRATO del wire (`FLAG_REASON` de `@veo/events`), porque
 * estos valores viajan en `driver.flagged`/`passenger.flagged` y los discrimina identity. Aquí solo se
 * RE-EXPORTA (una sola lista, cero duplicación): el dominio de rating produce estos valores y el contrato
 * los tipa con el MISMO enum, así nunca se desincronizan.
 */
export { FLAG_REASON, type FlagReason };

export interface FlagDecision {
  flagged: boolean;
  reason: FlagReason | null;
}

export interface FlagThresholds {
  /** BR-D01: por debajo de este promedio el conductor entra en "review". */
  driverReview: number;
  /** BR-D01: por debajo de este promedio el conductor entra en "suspension". */
  driverSuspension: number;
  /**
   * Mínimo de reseñas para que un promedio < `driverSuspension` ESCALE a 'suspension'. Por debajo de este
   * mínimo, un promedio bajo CAPA en 'review' (sigue flageado al panel, NO auto-suspende). Decisión del
   * dueño: no auto-suspender por pocas reseñas.
   */
  driverMinReviewsForSuspension: number;
  /** BR-I05: por debajo de este promedio el pasajero requiere re-verificación. */
  passengerReverify: number;
}

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = {
  driverReview: 4.3,
  driverSuspension: 4.0,
  driverMinReviewsForSuspension: 10,
  passengerReverify: 4.0,
};

const NO_FLAG: FlagDecision = { flagged: false, reason: null };

/**
 * BR-D01: rollingAvg < 4.0 → "suspension"; < 4.3 → "review"; en otro caso, sin flag.
 * No se evalúa con count === 0 (un sujeto sin calificaciones no se marca).
 *
 * MÍNIMO DE RESEÑAS (auto-suspensión por rating bajo · decisión del dueño): 'suspension' solo escala si
 * `count >= driverMinReviewsForSuspension`. Por debajo del mínimo, un promedio < 4.0 CAPA en 'review' (sigue
 * flageado al panel, NO auto-suspende) — no se castiga a un conductor por 1-2 reseñas malas tempranas.
 */
export function evaluateDriverFlag(
  avg: number,
  count: number,
  thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS,
): FlagDecision {
  if (count <= 0) return NO_FLAG;
  if (avg < thresholds.driverSuspension) {
    // < 4.0: suspende SOLO con suficientes reseñas; si no, cae a 'review' (flag de panel, no auto-suspende).
    const reason =
      count >= thresholds.driverMinReviewsForSuspension
        ? FLAG_REASON.SUSPENSION
        : FLAG_REASON.REVIEW;
    return { flagged: true, reason };
  }
  if (avg < thresholds.driverReview) return { flagged: true, reason: FLAG_REASON.REVIEW };
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
  if (avg < thresholds.passengerReverify) return { flagged: true, reason: FLAG_REASON.REVERIFICATION };
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
