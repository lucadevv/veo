import {useQuery} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {GetEarningsBreakdownUseCase, GetEarningsSummaryUseCase} from '../../domain';

/** Clave de caché del resumen de ganancias. */
export const EARNINGS_SUMMARY_QUERY_KEY = ['earnings', 'summary'] as const;
/** Clave de caché del desglose de ganancias (HOY/SEMANA). */
export const EARNINGS_BREAKDOWN_QUERY_KEY = ['earnings', 'breakdown'] as const;

/**
 * Query: resumen de ganancias del conductor. La respuesta incluye los payouts, así que esta única
 * llamada alimenta tanto los totales como la lista de liquidaciones de la pantalla.
 */
export function useEarningsSummary() {
  const {earnings} = useRepositories();
  return useQuery({
    queryKey: EARNINGS_SUMMARY_QUERY_KEY,
    queryFn: () => new GetEarningsSummaryUseCase(earnings).execute(),
  });
}

/**
 * Query: desglose de ganancias HOY y SEMANA. Es una segunda llamada independiente del summary;
 * se carga al entrar en la sección "Desglose" de la pantalla de ganancias.
 */
export function useEarningsBreakdown() {
  const {earnings} = useRepositories();
  return useQuery({
    queryKey: EARNINGS_BREAKDOWN_QUERY_KEY,
    queryFn: () => new GetEarningsBreakdownUseCase(earnings).execute(),
  });
}
