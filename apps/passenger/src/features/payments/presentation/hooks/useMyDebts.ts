import type {DebtView} from '@veo/api-client';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {useFocusEffect} from '@react-navigation/native';
import React from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {MY_DEBTS_QUERY_KEY} from '../../domain/queryKeys';

// La clave vive en `payments/domain` (compartida con el gate de deuda de Trip → caché coherente).
// La re-exportamos para no romper a los consumidores internos (barrel, `DebtSheet`).
export {MY_DEBTS_QUERY_KEY};

/**
 * Cuánto se considera "fresca" la deuda antes de re-consultar. Antes era 60s, y eso causaba que la
 * franja mostrara "pago pendiente" hasta un minuto DESPUÉS de que la deuda ya hubiera pasado a PENDING
 * (p.ej. el retry movió un DEBT a PENDING_ACTION): cache viejo, franja desactualizada. Lo bajamos a 5s:
 * sigue evitando el ruido de refetch render-a-render, pero al volver al home (refetchOnFocus) el estado
 * se refresca casi al instante. El estado de deuda SÍ cambia tras un pago, así que no debe quedar pegado.
 */
const DEBTS_STALE_TIME_MS = 5_000;

/** Helper para invalidar la franja desde cualquier llamador (al cerrar el sheet, tras saldar). */
export function useInvalidateMyDebts(): () => void {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({queryKey: MY_DEBTS_QUERY_KEY});
  }, [queryClient]);
}

/**
 * Ítems accionables del pasajero (`GET /payments/debts`, BR-P02): deudas (kind=DEBT) y pagos por
 * completar (kind=PENDING_ACTION). Señal PASIVA del home (franja sutil) y fuente del sheet. `enabled` lo
 * controla el llamador (solo en home idle). `staleTime` corto (5s) para que el estado no quede pegado
 * tras un pago. Además REFETCHEA AL VOLVER A FOCO (useFocusEffect): si el usuario fue a Yape y volvió, la
 * franja refleja el estado real sin esperar un TTL. Tras saldar/cerrar el sheet, el llamador invalida
 * esta key (useInvalidateMyDebts) para que la franja desaparezca/actualice al instante.
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
  // refetch() respeta el staleTime via el propio query: sólo pega a red si pasó el TTL → "razonable".
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
