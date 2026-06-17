import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  AcceptBidUseCase,
  CounterBidUseCase,
  ListOpenBidsUseCase,
  type OpenBid,
} from '../../domain';
import { isBidGoneError } from '../bid-errors';

/** Clave de caché de las pujas abiertas. La invalida el realtime cuando llega un ping de PUJA. */
export const BIDS_QUERY_KEY = ['bids'] as const;

/** Backstop del socket: si un ping `dispatch:offer` se pierde, el poll trae las pujas igual. */
const BIDS_POLL_MS = 12_000;

/**
 * Query: pujas OPEN cercanas que el conductor puede ofertar. Solo corre `enabled` (en turno): offline el
 * backend respondería 403/[] igual, así evitamos el request y mostramos el gate de turno en la UI.
 */
export function useOpenBids(enabled: boolean) {
  const { bidding } = useRepositories();
  return useQuery({
    queryKey: BIDS_QUERY_KEY,
    queryFn: () => new ListOpenBidsUseCase(bidding).execute(),
    enabled,
    refetchInterval: enabled ? BIDS_POLL_MS : false,
  });
}

/** Mutación: ACEPTAR la tarifa del bid tal cual (priceCents === bidCents). */
export function useAcceptBid() {
  const { bidding } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bid: OpenBid) => new AcceptBidUseCase(bidding).execute(bid),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY }),
    // Si la puja ya no está (otro la tomó / venció → 409/404), refrescá para soltarla de la lista.
    onError: (error) => {
      if (isBidGoneError(error)) queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY });
    },
  });
}

/** Mutación: CONTRAOFERTAR un precio mayor al bid. Valida el rango en el dominio antes de pegarle al BFF. */
export function useCounterBid() {
  const { bidding } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bid, priceCents }: { bid: OpenBid; priceCents: number }) =>
      new CounterBidUseCase(bidding).execute(bid, priceCents),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY }),
    onError: (error) => {
      if (isBidGoneError(error)) queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY });
    },
  });
}
