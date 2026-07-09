import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  EARNINGS_BREAKDOWN_QUERY_KEY,
  EARNINGS_DAILY_QUERY_KEY,
  EARNINGS_SUMMARY_QUERY_KEY,
  GetEarningsBreakdownUseCase,
  GetEarningsDailyUseCase,
  GetEarningsSummaryUseCase,
} from '../../domain';

// Las claves de ganancias viven ahora en `earnings/domain` (cache compartido con el dashboard de
// turno). Se re-exportan para no romper a los consumidores del barrel.
export { EARNINGS_BREAKDOWN_QUERY_KEY, EARNINGS_DAILY_QUERY_KEY, EARNINGS_SUMMARY_QUERY_KEY };

/**
 * Query: resumen de ganancias del conductor. La respuesta incluye los payouts, así que esta única
 * llamada alimenta tanto los totales como la lista de liquidaciones de la pantalla.
 */
export function useEarningsSummary() {
  const { earnings } = useRepositories();
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
  const { earnings } = useRepositories();
  return useQuery({
    queryKey: EARNINGS_BREAKDOWN_QUERY_KEY,
    queryFn: () => new GetEarningsBreakdownUseCase(earnings).execute(),
  });
}

/**
 * Query: serie diaria de la SEMANA en curso (7 puntos lun→dom) para el bar chart "Por día".
 * Independiente del breakdown; se carga junto con la pantalla de ganancias.
 */
export function useEarningsDaily() {
  const { earnings } = useRepositories();
  return useQuery({
    queryKey: EARNINGS_DAILY_QUERY_KEY,
    queryFn: () => new GetEarningsDailyUseCase(earnings).execute(),
  });
}
