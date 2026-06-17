import type { UserCreditView } from '@veo/api-client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';

/** Clave de caché del saldo de crédito gastable del pasajero (`GET /payments/credit`). */
export const USER_CREDIT_QUERY_KEY = ['payments', 'credit'] as const;

/**
 * Saldo de crédito GASTABLE del pasajero (redención de referidos · Ola 2A). Lo muestra "Invita y gana".
 * El cobro APLICA el crédito server-side (Lote B); esto es solo visibilidad. `staleTime` 30s: el saldo
 * cambia al GANAR (un referido completó su 1er viaje) o GASTAR (cobro de un viaje), no render-a-render.
 */
export function useUserCredit(): UseQueryResult<UserCreditView, Error> {
  const getUserCredit = useDependency(TOKENS.getUserCreditUseCase);
  return useQuery<UserCreditView, Error>({
    queryKey: USER_CREDIT_QUERY_KEY,
    queryFn: () => getUserCredit.execute(),
    staleTime: 30_000,
  });
}
