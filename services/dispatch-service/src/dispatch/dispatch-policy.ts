/**
 * Dispatch Policy v2 — helpers PUROS (sin Nest ni IO) del modelo de política de despacho por-modo.
 *
 * La política v1 (comportamiento actual) razona en K-RINGS H3 crudos (nearbyKRing/matchKRing +
 * DISPATCH_MAX_K_RING). La v2 razona en KILÓMETROS (más natural para el admin) y los TRADUCE a k-rings
 * con `radiusKmToKRing`. Todo acá es determinista y unit-testeado; el hot-path (matcher FIXED, broadcast
 * PUJA, radar-preview) consume estos helpers. NADA de esto toca el lookup espacial (neighbors/DriverPool/
 * RedisHotIndex) — solo la POLÍTICA de radios/umbrales encima.
 */

/**
 * Alcance aproximado por anillo H3 en resolución 9 (~0.3 km de radio efectivo por ring). Es la constante
 * de conversión km↔k del blueprint (res-9 ≈ celdas de ~174m de arista; un k-ring suma ~0.3km de radio).
 */
export const REACH_KM_PER_RING = 0.3;

/** Techo del k-ring (H3/latencia): un radio mayor satura Redis/CPU del hot-path. Espeja K_RING_MAX del DTO. */
export const MAX_POLICY_K_RING = 8;

/**
 * Mapea un radio en km al k-ring H3 más chico que lo cubre: `clamp(ceil(km / 0.3), 1, 8)`. PURO. Un km
 * ≤ 0.3 → k1 (mínimo útil: k0 no tendría vecinos); un km ≥ 2.4 → k8 (techo). NaN/inválido → k1 (piso seguro).
 */
export function radiusKmToKRing(km: number): number {
  const k = Math.ceil(km / REACH_KM_PER_RING);
  if (!Number.isFinite(k)) return 1;
  return Math.min(MAX_POLICY_K_RING, Math.max(1, k));
}

/**
 * Cotas de validación de la política v2 (fuente ÚNICA: el DTO las importa para no duplicar literales).
 * radiusKm 0.3..2.4 = k1..k8; incrementKm 0.1..1.0; targetDrivers 1..20; ventanas anti-footgun.
 */
export const POLICY_BOUNDS = {
  radiusKm: { min: 0.3, max: 2.4 },
  incrementKm: { min: 0.1, max: 1.0 },
  targetDrivers: { min: 1, max: 20 },
  offerTimeoutSec: { min: 5, max: 120 },
  /** Cadencia de expansión temporal (s) del matcher FIXED v2 (nextExpandAt). No estaba en v1; default 10. */
  expandIntervalSec: { min: 2, max: 60 },
  bidWindowSec: { min: 15, max: 300 },
} as const;

/** Default de la cadencia de expansión temporal cuando el JSON no la trae (compat / degradación honesta). */
export const DEFAULT_EXPAND_INTERVAL_SEC = 10;

/** Política del matcher FIXED (oferta directa secuencial): radios en km + umbral de candidatos + ventanas. */
export interface FixedPolicy {
  /** Radio inicial (km) de la búsqueda. Se traduce a startK = radiusKmToKRing(initialRadiusKm). */
  initialRadiusKm: number;
  /** Paso de expansión (km) — informativo para el radar-preview; el matcher expande por k-ring entero. */
  incrementKm: number;
  /** Radio máximo (km). Se traduce a maxK = radiusKmToKRing(maxRadiusKm). */
  maxRadiusKm: number;
  /** UMBRAL de candidatos: el matcher expande el ring hasta juntar ≥ targetDrivers (o llegar a maxK). */
  targetDrivers: number;
  /** Ventana (s) de la oferta directa antes de TIMEOUT + avance. */
  offerTimeoutSec: number;
  /** Cadencia (s) de expansión TEMPORAL del ring (nextExpandAt), desacoplada del timeout de la oferta. */
  expandIntervalSec: number;
}

/** Política del broadcast PUJA (single-shot): radio de broadcast en km + ventana del board. */
export interface PujaPolicy {
  /** Radio (km) del broadcast del bid. Se traduce a radiusKmToKRing(broadcastRadiusKm). */
  broadcastRadiusKm: number;
  /** Ventana (s) del board de PUJA (openBoard/reopenBoard). */
  bidWindowSec: number;
}

/** Política v2 completa (por modo) que viaja en la columna JSON `policy_v2`. */
export interface DispatchPolicyV2 {
  FIXED: FixedPolicy;
  PUJA: PujaPolicy;
}

/** Versión de política vigente + el snapshot v2 parseado (null si v1 o JSON malformado → degrada a v1). */
export interface DispatchPolicy {
  policyVersion: 'v1' | 'v2';
  v2: DispatchPolicyV2 | null;
}

/** Cotas efectivas del ring del matcher FIXED v2: startK (initial) y maxK (max, nunca menor que startK). */
export function fixedRingBounds(fixed: FixedPolicy): { startK: number; maxK: number } {
  const startK = radiusKmToKRing(fixed.initialRadiusKm);
  const maxK = Math.max(startK, radiusKmToKRing(fixed.maxRadiusKm));
  return { startK, maxK };
}

/**
 * Pasos de km del radar-preview FIXED: initial → +increment → … → max (inclusive), capeado a `cap` pasos.
 * Garantiza que el último paso sea maxRadiusKm. PURO; el service dedup-ea por k-ring para acotar el trabajo.
 */
export function fixedKmSteps(fixed: FixedPolicy, cap = MAX_POLICY_K_RING): number[] {
  const inc = fixed.incrementKm > 0 ? fixed.incrementKm : REACH_KM_PER_RING;
  const steps: number[] = [];
  for (
    let km = fixed.initialRadiusKm;
    km <= fixed.maxRadiusKm + 1e-9 && steps.length < cap;
    km += inc
  ) {
    steps.push(round1(km));
  }
  const last = steps[steps.length - 1];
  if (steps.length < cap && (last === undefined || last < fixed.maxRadiusKm - 1e-9)) {
    steps.push(round1(fixed.maxRadiusKm));
  }
  return steps;
}

/** Redondeo a 1 decimal (km): evita ruido de coma flotante en los pasos del radar (0.30000001 → 0.3). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Parsea/valida el JSON crudo de `policy_v2` a `DispatchPolicyV2` o `null`. DEFENSIVO por diseño: un JSON
 * ausente o malformado (columna legacy, edición manual rota) devuelve `null` → el hot-path degrada al
 * comportamiento v1, NUNCA crashea. No re-valida las cotas del DTO (esa es la 1ª barrera en el PUT); solo
 * exige que la estructura y los tipos sean coherentes. `expandIntervalSec` ausente → DEFAULT (compat).
 */
export function parsePolicyV2(raw: unknown): DispatchPolicyV2 | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const fixed = obj.FIXED as Record<string, unknown> | undefined;
  const puja = obj.PUJA as Record<string, unknown> | undefined;
  if (!fixed || typeof fixed !== 'object' || !puja || typeof puja !== 'object') return null;

  const initialRadiusKm = num(fixed.initialRadiusKm);
  const incrementKm = num(fixed.incrementKm);
  const maxRadiusKm = num(fixed.maxRadiusKm);
  const targetDrivers = num(fixed.targetDrivers);
  const offerTimeoutSec = num(fixed.offerTimeoutSec);
  const expandIntervalSec = numOr(fixed.expandIntervalSec, DEFAULT_EXPAND_INTERVAL_SEC);
  const broadcastRadiusKm = num(puja.broadcastRadiusKm);
  const bidWindowSec = num(puja.bidWindowSec);

  if (
    initialRadiusKm === null ||
    incrementKm === null ||
    maxRadiusKm === null ||
    targetDrivers === null ||
    offerTimeoutSec === null ||
    broadcastRadiusKm === null ||
    bidWindowSec === null
  ) {
    return null;
  }
  return {
    FIXED: {
      initialRadiusKm,
      incrementKm,
      maxRadiusKm,
      targetDrivers,
      offerTimeoutSec,
      expandIntervalSec,
    },
    PUJA: { broadcastRadiusKm, bidWindowSec },
  };
}

/** Número finito o null (rechaza NaN/Infinity/no-number). */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Número finito o el fallback (para campos opcionales con default). */
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
