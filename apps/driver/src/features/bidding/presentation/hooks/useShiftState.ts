import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { shiftStateQueryOptions } from '../../../../core/query/shiftStateQuery';

/**
 * Query FINA del estado de turno para bidding. Reusa la factory `shiftStateQueryOptions` (core/query):
 * MISMO cache + MISMA política crítica que el turno, SIN importar los hooks internos de
 * `shift/presentation` (feature-isolation). Bidding solo lee "¿el conductor está en turno?".
 */
export function useShiftState() {
  const { shift } = useRepositories();
  return useQuery(shiftStateQueryOptions(shift));
}
