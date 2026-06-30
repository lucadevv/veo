/**
 * Helpers de ENTRADA/SALIDA de dinero para los paneles de pricing/catálogo (formularios de soles).
 * El dinero en VEO SIEMPRE viaja en céntimos PEN (enteros) — FOUNDATION §8. Estos finos wrappers
 * reutilizan `solesToCents`/`centsToSoles` de `@veo/utils/money` (la ÚNICA fuente de verdad de la
 * conversión) y le agregan la semántica de los `<input>`: el campo vacío vale 0 y el value se muestra
 * con punto decimal crudo (sin "S/" ni separadores de miles — para LECTURA usar `formatPEN`).
 */
import { solesToCents, centsToSoles } from '@veo/utils/money';

/**
 * Parsea el value de un `<input>` de soles a céntimos Int (dinero SIEMPRE Int, nunca float persistido).
 * Vacío/blanco = 0. Redondea al céntimo vía `solesToCents` (Math.round), idéntico al viejo
 * `Math.round(Number(x) * 100)` inline que reimplementaban los paneles.
 */
export function parseSolesInput(value: string): number {
  return value.trim() === '' ? 0 : solesToCents(Number(value));
}

/**
 * Formatea céntimos Int al string de un `<input>`/hint de soles (150 → "1.50"). SIN "S/" ni separadores
 * de miles (a diferencia de `formatPEN`, que es para LECTURA): el `value` de un `<input type=number>` y
 * los hints "Actual: S/x" usan el punto decimal crudo.
 */
export function formatSolesInput(cents: number): string {
  return centsToSoles(cents).toFixed(2);
}
