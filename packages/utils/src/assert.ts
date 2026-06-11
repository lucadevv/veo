/**
 * Aserciones de exhaustividad (switches SIN default silencioso).
 */

/**
 * Chequeo de exhaustividad para uniones discriminadas: se llama en el `default` de un switch que
 * cubre todos los casos. Doble red:
 *  - COMPILACIÓN: si a la unión se le agrega una variante y el switch no la maneja, el argumento
 *    deja de ser `never` y TypeScript marca el error EN el switch (extender = el compilador te guía).
 *  - RUNTIME: si igualmente llega un valor imprevisto (dato viejo, cast forzado, contrato roto),
 *    LANZA en vez de seguir por una rama implícita — el bug explota visible, no se traga.
 *
 * Lanza `Error` crudo a propósito: una variante no contemplada es un error de PROGRAMACIÓN
 * (invariante rota), no un error de dominio del catálogo (errors.ts) — el ExceptionFilter lo mapea
 * a 500 INTERNAL, que es la señal honesta para un estado inalcanzable.
 */
export function assertNever(value: never, message = 'Variante no contemplada'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
