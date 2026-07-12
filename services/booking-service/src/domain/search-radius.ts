/**
 * F2 · Mapeo RADIO (km) → k-ring H3 del carpooling. DOMINIO PURO (sin I/O): la conversión entre la unidad
 * que el admin edita (kilómetros) y el anillo H3 que consume la búsqueda geo (neighbors(celda, k)).
 *
 * POR QUÉ km ↔ k: el admin razona en distancia ("busca autos hasta 600m"), pero la búsqueda H3 razona en
 * anillos discretos de celdas (res-9 ≈ 0.3km de "paso" por anillo urbano en Lima). Guardamos km en la config
 * (unidad de negocio, estable) y derivamos el k en runtime — así el modelo del admin no filtra el detalle H3.
 *
 * FÓRMULA ÚNICA: `k = clamp(ceil(km / 0.3), 0, 8)`. `ceil` (no round) porque el radio es un MÍNIMO garantizado
 * ("al menos este alcance"): 0.31km debe abarcar 2 anillos, no 1. k=0 es válido en carpooling (solo la celda
 * de origen, sin corona); el tope k=8 acota el blast-radius del hot-path (un anillo enorme barrería media Lima).
 */

/** "Paso" de un anillo H3 res-9 en km (≈ el radio de una celda urbana en Lima). Constante de dominio única. */
export const H3_RES9_RING_KM = 0.3;

/** Tope superior del k-ring (anti-footgun: un radio gigante satura la query/CPU del hot-path). */
export const MAX_SEARCH_K_RING = 8;

/** Piso del k-ring. 0 = solo la celda de origen (carpooling admite radio "puntual", sin corona de vecinos). */
export const MIN_SEARCH_K_RING = 0;

/**
 * Convierte un radio en km al k-ring H3 res-9 equivalente: `clamp(ceil(km / 0.3), 0, 8)`. `ceil` porque el
 * radio es un MÍNIMO garantizado (un radio a mitad de anillo cubre el anillo siguiente). Clamp defensivo por
 * si un km fuera de rango se cuela (el DTO ya lo acota en el borde; esto es defensa en profundidad).
 */
export function kRingForRadiusKm(km: number): number {
  const k = Math.ceil(km / H3_RES9_RING_KM);
  return Math.min(Math.max(k, MIN_SEARCH_K_RING), MAX_SEARCH_K_RING);
}
