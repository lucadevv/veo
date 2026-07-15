import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { shiftStateQueryOptions, type ShiftStateView } from '../../../../core/query/shiftStateQuery';
import {
  EndShiftUseCase,
  PauseShiftUseCase,
  SHIFT_STATE_QUERY_KEY,
  StartShiftUseCase,
  type ShiftStartGeo,
} from '../../domain';
import { recordShiftStart } from '../state/shiftClock';

// `SHIFT_STATE_QUERY_KEY` vive ahora en `shift/domain` (cache compartido con bidding/realtime/viajes)
// y la POLÍTICA de fetching del estado de turno en `core/query/shiftStateQuery` (única fuente, sin
// divergencia entre features). Ambos se re-exportan para no romper a los consumidores del barrel.
export { SHIFT_STATE_QUERY_KEY };
export type { ShiftStateView };

/** Query: estado actual del turno del conductor (política crítica centralizada en `core/query`). */
export function useShiftState() {
  const { shift } = useRepositories();
  return useQuery(shiftStateQueryOptions(shift));
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
