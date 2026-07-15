import type {UserCreditView} from '@veo/api-client';
import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {USER_CREDIT_QUERY_KEY} from '../../../payments/domain/queryKeys';

/**
 * Saldo de crédito GASTABLE del pasajero (redención de referidos · Ola 2A). Lo muestra "Invita y gana".
 * El cobro APLICA el crédito server-side (Lote B); esto es solo visibilidad. `staleTime` 30s: el saldo
 * cambia al GANAR (un referido completó su 1er viaje) o GASTAR (cobro de un viaje), no render-a-render.
 *
 * Hook fino LOCAL de Referidos: envuelve el caso de uso público `GetUserCreditUseCase` (resuelto por DI)
 * y la clave compartida `USER_CREDIT_QUERY_KEY` de `payments/domain` —sin tocar la `presentation` de
 * Payments, respetando el aislamiento de features (la caché del saldo sigue siendo una sola).
 */
export function useUserCredit(): UseQueryResult<UserCreditView, Error> {
  const getUserCredit = useDependency(TOKENS.getUserCreditUseCase);
  return useQuery<UserCreditView, Error>({
    queryKey: USER_CREDIT_QUERY_KEY,
    queryFn: () => getUserCredit.execute(),
    staleTime: 30_000,
  });
}
