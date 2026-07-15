import type {DebtView} from '@veo/api-client';
import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {useFocusEffect} from '@react-navigation/native';
import React from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {MY_DEBTS_QUERY_KEY} from '../../../payments/domain/queryKeys';

/**
 * Cuánto se considera "fresca" la deuda antes de re-consultar (5s): evita el ruido de refetch
 * render-a-render, pero al volver al home (refetchOnFocus) el estado se refresca casi al instante. El
 * estado de deuda SÍ cambia tras un pago, así que no debe quedar pegado.
 */
const DEBTS_STALE_TIME_MS = 5_000;

/**
 * Ítems accionables del pasajero (`GET /payments/debts`, BR-P02): deudas (kind=DEBT) y pagos por
 * completar (kind=PENDING_ACTION). Fuente del gate de deuda del home (`useDebtGate`).
 *
 * Hook fino LOCAL de Trip: envuelve el caso de uso público `GetMyDebtsUseCase` (resuelto por DI) y la
 * clave compartida `MY_DEBTS_QUERY_KEY` de `payments/domain` —sin tocar la `presentation` de Payments,
 * respetando el aislamiento de features. La caché es la MISMA que la de Payments (misma key): saldar
 * desde el `DebtSheet` invalida esta franja al instante.
 *
 * REFETCHEA AL VOLVER A FOCO (`useFocusEffect`): si el usuario fue a Yape y volvió, la franja refleja el
 * estado real sin esperar el TTL. `enabled` lo controla el llamador (solo en home idle).
 */
export function useMyDebts(enabled: boolean): UseQueryResult<DebtView, Error> {
  const getMyDebts = useDependency(TOKENS.getMyDebtsUseCase);
  const query = useQuery<DebtView, Error>({
    queryKey: MY_DEBTS_QUERY_KEY,
    queryFn: () => getMyDebts.execute(),
    enabled,
    staleTime: DEBTS_STALE_TIME_MS,
  });

  // Al recuperar foco (volver al home tras Yape / otra pantalla), refrescamos si está habilitado y stale.
  const {refetch} = query;
  useFocusEffect(
    React.useCallback(() => {
      if (enabled) {
        void refetch();
      }
    }, [enabled, refetch]),
  );

  return query;
}
