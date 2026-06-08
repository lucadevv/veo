/**
 * Cálculo puro del promedio rolling de N días (BR-D01 / BR-I05).
 * Sin I/O ni dependencias de Nest: testeable de forma aislada.
 */

/** Una calificación con su instante de creación, para filtrar por ventana. */
export interface TimedRating {
  stars: number;
  createdAt: Date;
}

export interface RollingAverage {
  /** Promedio redondeado a 2 decimales sobre la ventana. 0 si no hay calificaciones. */
  avg: number;
  /** Número de calificaciones dentro de la ventana. */
  count: number;
}

/** Instante de corte: ahora - windowDays. Las calificaciones >= cutoff entran en la ventana. */
export function windowCutoff(windowDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

/** Redondea a 2 decimales evitando errores binarios (4.005 → 4.01). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Promedio sobre una lista de estrellas ya filtrada por ventana.
 * Útil cuando la query ya aplicó el filtro temporal en la DB.
 */
export function averageOfStars(stars: readonly number[]): RollingAverage {
  if (stars.length === 0) return { avg: 0, count: 0 };
  const sum = stars.reduce((acc, s) => acc + s, 0);
  return { avg: round2(sum / stars.length), count: stars.length };
}

/**
 * Promedio rolling filtrando in-memory por la ventana de `windowDays`.
 * Solo cuentan calificaciones con createdAt >= (now - windowDays).
 */
export function computeRollingAverage(
  ratings: readonly TimedRating[],
  windowDays: number,
  now: Date = new Date(),
): RollingAverage {
  const cutoff = windowCutoff(windowDays, now);
  const inWindow = ratings.filter((r) => r.createdAt.getTime() >= cutoff.getTime());
  return averageOfStars(inWindow.map((r) => r.stars));
}
