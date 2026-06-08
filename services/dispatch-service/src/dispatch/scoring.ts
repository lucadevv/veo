/**
 * Algoritmo de scoring de matching (BR-T06). Función PURA, sin I/O ni estado.
 *
 *   score = w_dist * (1 / distanciaMetros)
 *         + w_rating * avgRating
 *         + w_idle  * (1 / segundosDesdeUltimoViaje)
 *         - w_cancel * cancellationRate
 *
 * Mayor score = mejor candidato. Los pesos son configurables (env), pero el scorer los recibe
 * por constructor para ser determinista y testeable de forma aislada (S de SOLID).
 */

export interface ScoringWeights {
  /** Peso del término de cercanía (1/distancia). */
  distance: number;
  /** Peso del rating promedio (1..5). */
  rating: number;
  /** Peso del término de actividad reciente (1/segundos desde el último viaje). */
  idle: number;
  /** Peso (penalización) de la tasa de cancelación (0..1). */
  cancel: number;
}

export interface ScoreInput {
  driverId: string;
  /** Distancia en metros del conductor al origen del viaje. */
  distanceMeters: number;
  /** Rating promedio del conductor (1..5). */
  avgRating: number;
  /** Segundos desde el último viaje completado (grande si nunca tuvo uno). */
  secondsSinceLastTrip: number;
  /** Tasa de cancelación 0..1. */
  cancellationRate: number;
}

export interface ScoredCandidate extends ScoreInput {
  score: number;
}

/** Evita divisiones por cero y valores negativos en los términos inversos. */
function safe(value: number): number {
  return value > 1 ? value : 1;
}

export class DispatchScorer {
  constructor(private readonly weights: ScoringWeights) {}

  score(input: ScoreInput): number {
    const distanceTerm = this.weights.distance * (1 / safe(input.distanceMeters));
    const ratingTerm = this.weights.rating * input.avgRating;
    const idleTerm = this.weights.idle * (1 / safe(input.secondsSinceLastTrip));
    const cancelPenalty = this.weights.cancel * input.cancellationRate;
    return distanceTerm + ratingTerm + idleTerm - cancelPenalty;
  }

  /** Calcula el score de cada candidato y los ordena de mejor a peor (score descendente). */
  rank(inputs: ScoreInput[]): ScoredCandidate[] {
    return inputs
      .map((input) => ({ ...input, score: this.score(input) }))
      .sort((a, b) => b.score - a.score);
  }
}
