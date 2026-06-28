import { PanicStatus } from '@veo/shared-types';
import { FILTER_ALL } from '@/lib/filters';

/**
 * Sentinel "sin filtro" del tab "Todos" — NO es un estado de dominio. `cleanQuery` lo elimina de la
 * query (mismo patrón que los filtros de viajes), así el server recibe el param ausente y devuelve
 * TODOS los pánicos. Deriva del sentinel GENÉRICO `FILTER_ALL` (fuente única) para no divergir.
 */
export const PANIC_FILTER_ALL = FILTER_ALL;

export type PanicTab = PanicStatus | typeof PANIC_FILTER_ALL;

/**
 * Filtros del panel de pánicos. Los valores de DOMINIO salen del enum tipado `PanicStatus` (PROHIBIDO
 * el string suelto: el admin-bff valida `status` con `@IsIn(PANIC_STATUSES)`, así que mandar 'OPEN'
 * daba 400 y la página de SEGURIDAD aterrizaba rota en su tab por defecto, ocultando pánicos activos).
 * "Sin atender" = TRIGGERED (disparado, nadie lo reconoció aún) = la vista MÁS urgente → es el default.
 */
export const PANIC_TABS: { value: PanicTab; label: string }[] = [
  { value: PanicStatus.TRIGGERED, label: 'Sin atender' },
  { value: PanicStatus.ACKNOWLEDGED, label: 'Reconocidos' },
  { value: PANIC_FILTER_ALL, label: 'Todos' },
];

/** Tab por defecto: la cola urgente de pánicos sin atender. */
export const DEFAULT_PANIC_TAB: PanicTab = PanicStatus.TRIGGERED;
