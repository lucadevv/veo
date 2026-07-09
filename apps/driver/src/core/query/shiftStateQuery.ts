import { queryOptions } from '@tanstack/react-query';
import {
  GetShiftStateUseCase,
  SHIFT_STATE_QUERY_KEY,
  parseShiftStatus,
  type ShiftRepository,
  type ShiftStatus,
} from '../../features/shift/domain';

/** Vista normalizada del estado de turno para la UI. */
export interface ShiftStateView {
  driverId: string;
  /** Estado normalizado para la UI. */
  status: ShiftStatus;
  /** Valor crudo del servidor (para mostrar/diagnóstico). */
  rawStatus: string;
}

/**
 * Cada cuánto se re-consulta el estado de turno mientras la app está en primer plano (ms). El estado
 * es server-authoritative: si la central SUSPENDE al conductor mid-turno y NO llega un evento de
 * socket, el polling lo detecta igual. RN no refetchea en background por defecto, así que esto no
 * corre dormido.
 */
const SHIFT_STATE_REFETCH_INTERVAL_MS = 30_000;

/**
 * Factory de `queryOptions` (TanStack v5) del estado de turno. Es la ÚNICA fuente de la política de
 * fetching CRÍTICA (regla #1: un suspendido no opera) — polling acotado + refetch al volver a primer
 * plano (vía focusManager↔AppState) — para que NO diverja entre las features que leen el turno
 * (`shift`, `bidding`, `realtime`). Vive en `core/query` (composition-infra que ya conoce los repos por
 * el contenedor DI) y toma el `ShiftRepository` inyectado; los consumidores hacen
 * `useQuery(shiftStateQueryOptions(shift))` sin importar la `presentation` ajena (feature-isolation).
 */
export function shiftStateQueryOptions(shift: ShiftRepository) {
  return queryOptions<ShiftStateView>({
    queryKey: SHIFT_STATE_QUERY_KEY,
    queryFn: async () => {
      const state = await new GetShiftStateUseCase(shift).execute();
      return {
        driverId: state.driverId,
        status: parseShiftStatus(state.status),
        rawStatus: state.status,
      };
    },
    refetchInterval: SHIFT_STATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
}
