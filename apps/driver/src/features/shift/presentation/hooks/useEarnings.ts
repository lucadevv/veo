import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  EARNINGS_BREAKDOWN_QUERY_KEY,
  EARNINGS_SUMMARY_QUERY_KEY,
  GetEarningsBreakdownUseCase,
  GetEarningsSummaryUseCase,
} from '../../../earnings/domain';

/**
 * Hooks FINOS de ganancias que consume el TURNO (tarjeta de ganancias del dashboard, resumen de
 * cierre). Envuelven los casos de uso públicos de `earnings/domain` sobre las claves COMPARTIDAS: MISMO
 * cache que `earnings/presentation` (coherente), SIN importar sus hooks internos (feature-isolation).
 */

/** Query: resumen de ganancias del conductor (totales + payouts). */
export function useEarningsSummary() {
  const { earnings } = useRepositories();
  return useQuery({
    queryKey: EARNINGS_SUMMARY_QUERY_KEY,
    queryFn: () => new GetEarningsSummaryUseCase(earnings).execute(),
  });
}

/** Query: desglose de ganancias HOY y SEMANA. */
export function useEarningsBreakdown() {
  const { earnings } = useRepositories();
  return useQuery({
    queryKey: EARNINGS_BREAKDOWN_QUERY_KEY,
    queryFn: () => new GetEarningsBreakdownUseCase(earnings).execute(),
  });
}
