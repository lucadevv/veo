/**
 * Sentinel "sin filtro" del tab/selector "Todos" — NO es un estado de dominio. `cleanQuery` lo ELIMINA de la
 * query (el server recibe el param ausente → devuelve TODO) y los selectores de lista lo usan como opción
 * "Todos". FUENTE ÚNICA: evita re-tipear el string suelto (y que diverja) entre `cleanQuery`, los filtros de
 * viajes y los de pánicos — antes estaba hardcodeado por separado en cada uno (double-source).
 */
export const FILTER_ALL = 'ALL' as const;
export type FilterAll = typeof FILTER_ALL;
