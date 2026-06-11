/**
 * Helpers PUROS de la config de RADIOS (k-rings) de dispatch. Sin React ni I/O: solo traducción del
 * contrato `dispatchRadiusConfigView` a una magnitud que el operador entiende (metros aproximados).
 * Viven aquí (no en el componente) para ser testeables y reutilizables (clean: la presentación
 * consume, no calcula).
 *
 * Un k-ring de H3 a resolución 9 (la que usa dispatch) cubre, anillo a anillo, un radio aproximado.
 * Estas equivalencias son orientativas para que el admin razone en metros, NO el valor exacto del
 * indexado geoespacial (que depende de la latitud). El backend opera siempre en k-rings.
 */

/** Límites duros del contrato (`dispatchRadiusConfigView`: int 1..8). Una sola fuente de verdad. */
export const K_RING_MIN = 1;
export const K_RING_MAX = 8;

/** Radio aproximado en metros que cubre cada k-ring (H3 res-9). Índice = k. */
const K_RING_METERS: readonly number[] = [
  0, // k=0 (solo la celda central; no se usa como radio de búsqueda)
  470, // k=1
  780, // k=2
  1000, // k=3
  1400, // k=4
  1700, // k=5
  2100, // k=6
  2400, // k=7
  2700, // k=8
];

/** k-ring → radio aproximado en metros. Clampa al rango conocido (el contrato sólo admite 1..8). */
export function kRingMeters(k: number): number {
  if (k <= 0) return 0;
  const idx = Math.min(k, K_RING_METERS.length - 1);
  return K_RING_METERS[idx] ?? 0;
}

/** k-ring → etiqueta humana del radio aproximado ('≈ 470 m' / '≈ 1.4 km'). */
export function kRingLabel(k: number): string {
  const meters = kRingMeters(k);
  return meters >= 1000 ? `≈ ${(meters / 1000).toFixed(1)} km` : `≈ ${meters} m`;
}

/** ¿El valor cae dentro del rango válido del contrato (entero 1..8)? */
export function isValidKRing(k: number): boolean {
  return Number.isInteger(k) && k >= K_RING_MIN && k <= K_RING_MAX;
}
