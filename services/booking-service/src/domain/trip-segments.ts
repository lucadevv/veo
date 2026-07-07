/**
 * Invariante de dominio: los TRAMOS (`precioPorTramo`) derivan de los HITOS de la ruta (ADR-014 §2.1).
 * Un tramo `{ desdeOrden, hastaOrden, precioCentimos }` factura el trayecto entre dos hitos; si apunta a un
 * `orden` que NO existe entre los hitos del MISMO payload/estado final, es un tramo HUÉRFANO — datos de
 * pricing que ningún pasajero podría comprar (no hay tal segmento). Este módulo concentra la regla TIPADA
 * para que publish() y update() la apliquen de forma idéntica (no inline disperso).
 *
 * MODELO DE HITOS — FUENTE ÚNICA (este módulo es el dueño; resolvePrecioPorTramo del service la IMPORTA):
 *  - origen   → orden 0 (siempre).
 *  - stopovers → sus `orden` declarados (1..n).
 *  - destino  → un hito PROPIO, DESPUÉS del último stopover: `max(stopovers.orden) + 1` (n+1). El destino NO
 *    se conflaciona con el último stopover; sin stopovers, el destino es orden 1 (origen=0 → destino=1).
 *
 * Así, el set de órdenes VÁLIDOS es { 0, ...stopovers.orden, destinoOrden }. Todo `desdeOrden`/`hastaOrden`
 * de cada tramo debe pertenecer a ese set, y el tramo debe avanzar (`desdeOrden < hastaOrden`): un tramo
 * que no avanza o que salta a un hito inexistente rompe el invariante. El tramo legítimo "último stopover →
 * destino" (`n → n+1`) es VÁLIDO por construcción — el destino existe como hito separado.
 *
 * `destinoOrden()` es la ÚNICA función que decide "cuál es el orden del destino": la validación y el resolver
 * de tramos del service la comparten → CERO drift de modelo (si uno usara max y el otro max+1, el invariante
 * rechazaría lo que el default genera).
 */
import { ValidationError } from '@veo/utils';

/** Hito intermedio de la ruta: solo el `orden` importa para la integridad referencial de los tramos. */
export interface StopoverLike {
  orden: number;
}

/**
 * INVARIANTE DE HITOS (fail-closed, defensa en profundidad del borde DTO). El conjunto de órdenes de los
 * stopovers DEBE ser exactamente `{1..n}` contiguo: ninguno en 0 (reservado al origen), ninguno colisionando
 * con otro (unicidad), ninguno por encima de `n` (que pisaría el destino = n+1) ni con huecos. Cualquier
 * desviación → ValidationError TIPADO (NUNCA last-write-wins silencioso en el Map de hitos). El borde (DTO)
 * ya lo valida; esta función es la red de dominio que garantiza que el cálculo full-route y el por-tramo
 * usen SIEMPRE el MISMO set de hitos consistente — origen(0), stopovers(1..n únicos), destino(n+1).
 */
export function assertStopoverOrdersValid(stopovers: readonly StopoverLike[]): void {
  const n = stopovers.length;
  const seen = new Set<number>();
  for (const s of stopovers) {
    if (!Number.isInteger(s.orden)) {
      throw new ValidationError('El orden de un stopover debe ser un entero', { orden: s.orden });
    }
    if (s.orden < 1) {
      // orden 0 = origen (reservado); negativos son inválidos. Un stopover acá pisaría el origen.
      throw new ValidationError(
        'El orden de un stopover debe ser ≥ 1 (el 0 está reservado al origen)',
        {
          orden: s.orden,
        },
      );
    }
    if (s.orden > n) {
      // n+1 = destino: un stopover en orden ≥ n+1 pisaría el destino (o deja un hueco antes de él).
      throw new ValidationError(
        'El orden de un stopover excede el rango {1..n} (colisionaría con el destino)',
        {
          orden: s.orden,
          n,
        },
      );
    }
    if (seen.has(s.orden)) {
      throw new ValidationError('Hay stopovers con el mismo orden (los órdenes deben ser únicos)', {
        orden: s.orden,
      });
    }
    seen.add(s.orden);
  }
  // En este punto: n valores enteros, todos en [1..n], todos únicos → necesariamente son exactamente {1..n}
  // contiguo (sin huecos ni colisión con origen=0/destino=n+1). El invariante queda sellado.
}

/** Tramo de pricing: factura el trayecto [desdeOrden → hastaOrden] entre dos hitos. */
export interface TramoLike {
  desdeOrden: number;
  hastaOrden: number;
}

/**
 * FUENTE ÚNICA del orden del destino (ADR-014 §2.1, modelo de hitos). El destino es un hito PROPIO DESPUÉS
 * del último stopover: `max(stopovers.orden) + 1`; sin stopovers, es 1 (origen=0 → destino=1). Tanto la
 * validación de integridad como `resolvePrecioPorTramo` del service consumen ESTA función → cero drift.
 */
export function destinoOrden(stopovers: readonly StopoverLike[]): number {
  if (stopovers.length === 0) return 1;
  return Math.max(...stopovers.map((s) => s.orden)) + 1;
}

/**
 * Calcula el conjunto de órdenes de hito VÁLIDOS para un set de stopovers, incluyendo origen (0) y destino.
 * El destino lo decide `destinoOrden()` (fuente única) — `max(stopovers.orden) + 1`, o 1 sin stopovers.
 */
export function validStopoverOrders(stopovers: readonly StopoverLike[]): Set<number> {
  const orders = new Set<number>([0]); // origen
  for (const s of stopovers) orders.add(s.orden);
  orders.add(destinoOrden(stopovers)); // destino = hito propio tras el último stopover (n+1)
  return orders;
}

/**
 * Verifica la INTEGRIDAD REFERENCIAL stopovers↔tramos: cada tramo debe referenciar órdenes de hito que
 * EXISTEN en el estado final (origen=0 ∪ stopovers ∪ destino) y avanzar (`desdeOrden < hastaOrden`). Si un
 * tramo apunta a un hito inexistente, o no avanza, lanza ValidationError TIPADO con la causa concreta — un
 * tramo huérfano nunca se persiste. Idempotente y pura: misma entrada → misma decisión, en publish y update.
 */
export function assertTramosReferToValidStopovers(
  stopovers: readonly StopoverLike[],
  tramos: readonly TramoLike[],
): void {
  const valid = validStopoverOrders(stopovers);
  for (const tramo of tramos) {
    if (!valid.has(tramo.desdeOrden)) {
      throw new ValidationError(
        'Un tramo referencia un hito (desdeOrden) que no existe en la ruta',
        { desdeOrden: tramo.desdeOrden, ordenesValidos: [...valid] },
      );
    }
    if (!valid.has(tramo.hastaOrden)) {
      throw new ValidationError(
        'Un tramo referencia un hito (hastaOrden) que no existe en la ruta',
        { hastaOrden: tramo.hastaOrden, ordenesValidos: [...valid] },
      );
    }
    if (tramo.desdeOrden >= tramo.hastaOrden) {
      throw new ValidationError('Un tramo no avanza (desdeOrden debe ser menor a hastaOrden)', {
        desdeOrden: tramo.desdeOrden,
        hastaOrden: tramo.hastaOrden,
      });
    }
  }
}
