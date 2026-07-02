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

/* ── Ventanas de dispatch (config editable por el admin) ──────────────────────────────────────────
 * La oferta directa se persiste en MILISEGUNDOS (offerTimeoutMs, contrato 5000..120000) pero al operador
 * se le muestra/edita en SEGUNDOS (más legible). El board de puja ya está en segundos (bidWindowSec,
 * contrato 15..300). Las cotas de segundos derivan 1:1 de las del contrato para una sola fuente de verdad.
 */

/** Cotas de la ventana de la oferta directa, en SEGUNDOS (5000..120000 ms → 5..120 s). */
export const OFFER_TIMEOUT_SEC_MIN = 5;
export const OFFER_TIMEOUT_SEC_MAX = 120;
/** Cotas de la ventana del board de puja, en segundos (contrato). */
export const BID_WINDOW_SEC_MIN = 15;
export const BID_WINDOW_SEC_MAX = 300;

/** ms ⇄ s (la UI edita segundos; el contrato guarda ms para la oferta directa). */
export function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}
export function secToMs(s: number): number {
  return Math.round(s * 1000);
}

/** ¿La ventana de oferta directa (en segundos) es un entero dentro del rango válido? */
export function isValidOfferTimeoutSec(s: number): boolean {
  return Number.isInteger(s) && s >= OFFER_TIMEOUT_SEC_MIN && s <= OFFER_TIMEOUT_SEC_MAX;
}

/** ¿La ventana de puja (en segundos) es un entero dentro del rango válido? */
export function isValidBidWindowSec(s: number): boolean {
  return Number.isInteger(s) && s >= BID_WINDOW_SEC_MIN && s <= BID_WINDOW_SEC_MAX;
}
