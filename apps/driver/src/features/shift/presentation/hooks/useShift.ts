import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {
  EndShiftUseCase,
  GetShiftStateUseCase,
  PauseShiftUseCase,
  StartShiftUseCase,
  parseShiftStatus,
  type ShiftStartGeo,
  type ShiftStatus,
} from '../../domain';

/** Clave de caché del estado de turno. */
export const SHIFT_STATE_QUERY_KEY = ['shift', 'state'] as const;

export interface ShiftStateView {
  driverId: string;
  /** Estado normalizado para la UI. */
  status: ShiftStatus;
  /** Valor crudo del servidor (para mostrar/diagnóstico). */
  rawStatus: string;
}

/** Query: estado actual del turno del conductor. */
export function useShiftState() {
  const {shift} = useRepositories();
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
  });
}

/** Mutación: iniciar/reanudar turno con el `sessionRef` biométrico ya obtenido. */
export function useStartShift() {
  const {shift} = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({sessionRef, geo}: {sessionRef: string; geo?: ShiftStartGeo}) =>
      new StartShiftUseCase(shift).execute(sessionRef, geo),
    onSuccess: () => queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY}),
  });
}

/** Mutación: finalizar turno (→ OFFLINE). */
export function useEndShift() {
  const {shift} = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new EndShiftUseCase(shift).execute(),
    onSuccess: () => queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY}),
  });
}

/** Mutación: pausar turno (→ ON_BREAK). */
export function usePauseShift() {
  const {shift} = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new PauseShiftUseCase(shift).execute(),
    onSuccess: () => queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY}),
  });
}
