import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  EndShiftUseCase,
  GetShiftStateUseCase,
  PauseShiftUseCase,
  StartShiftUseCase,
  parseShiftStatus,
  type ShiftStartGeo,
  type ShiftStatus,
} from '../../domain';
import { recordShiftStart } from '../state/shiftClock';

/** Clave de caché del estado de turno. */
export const SHIFT_STATE_QUERY_KEY = ['shift', 'state'] as const;

/**
 * Cada cuánto se re-consulta el estado de turno mientras la app está en primer plano (ms). El estado
 * es server-authoritative: si la central SUSPENDE al conductor mid-turno y NO llega un evento de socket,
 * el polling lo detecta igual. RN no refetchea en background por defecto, así que esto no corre dormido.
 */
const SHIFT_STATE_REFETCH_INTERVAL_MS = 30_000;

export interface ShiftStateView {
  driverId: string;
  /** Estado normalizado para la UI. */
  status: ShiftStatus;
  /** Valor crudo del servidor (para mostrar/diagnóstico). */
  rawStatus: string;
}

/** Query: estado actual del turno del conductor. */
export function useShiftState() {
  const { shift } = useRepositories();
  return useQuery<ShiftStateView>({
    queryKey: SHIFT_STATE_QUERY_KEY,
    queryFn: async () => {
      const state = await new GetShiftStateUseCase(shift).execute();
      return {
        driverId: state.driverId,
        status: parseShiftStatus(state.status),
        rawStatus: state.status,
      };
    },
    // Seguridad operativa (regla #1: un suspendido no opera). El default global es no revalidar
    // (`refetchOnWindowFocus:false`); acá lo forzamos para ESTE estado crítico: polling acotado +
    // refetch al volver a primer plano (vía focusManager↔AppState, ver `nativeAppState.ts`).
    refetchInterval: SHIFT_STATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Mutación: iniciar/reanudar turno con el `sessionRef` biométrico ya obtenido. */
export function useStartShift() {
  const { shift } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionRef, geo }: { sessionRef: string; geo?: ShiftStartGeo }) =>
      new StartShiftUseCase(shift).execute(sessionRef, geo),
    onSuccess: () => {
      // Sella el reloj de turno LOCAL: el backend no expone `startedAt`, así que el resumen de cierre
      // mide la duración desde este instante (degrada honesto si la marca no está al cerrar).
      recordShiftStart();
      queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
    },
  });
}

/** Mutación: finalizar turno (→ OFFLINE). */
export function useEndShift() {
  const { shift } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new EndShiftUseCase(shift).execute(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY }),
  });
}

/** Mutación: pausar turno (→ ON_BREAK). */
export function usePauseShift() {
  const { shift } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new PauseShiftUseCase(shift).execute(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY }),
  });
}
