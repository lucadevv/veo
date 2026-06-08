import type { TripHistoryItem, TripHistoryPage } from '@veo/api-client';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';

/** Clave de cache del historial paginado (una sola "lista infinita" por pasajero). */
export const tripHistoryKey = ['trips', 'history'] as const;

/** Tamaño de página pedido al BFF (el servidor lo acota; es solo una sugerencia). */
const PAGE_SIZE = 20;

export interface UseTripHistoryResult {
  /** Todos los items de todas las páginas cargadas, aplanados y en orden (requestedAt DESC). */
  items: TripHistoryItem[];
  /** Primera carga (sin datos todavía): pinta el skeleton. */
  isLoading: boolean;
  /** Error de la primera carga: pinta el estado reintentable. */
  isError: boolean;
  /** Hay una página siguiente (nextCursor != null). */
  hasNextPage: boolean;
  /** Se está trayendo la página siguiente (footer "cargando más"). */
  isFetchingNextPage: boolean;
  /** Refresco pull-to-refresh en curso (con datos ya en pantalla). */
  isRefetching: boolean;
  /** Pide la página siguiente (idempotente si ya está cargando o no hay más). */
  fetchNextPage: () => void;
  /** Reintenta desde cero (estado de error) o refresca (pull-to-refresh). */
  refetch: () => void;
}

/**
 * Historial de viajes del pasajero leído del SERVIDOR con paginación infinita por CURSOR (keyset).
 *
 * Por qué `useInfiniteQuery` y no un `list()` local: el snapshot MMKV mostraba la foto vieja del viaje
 * (todo "Solicitado") y nunca se actualizaba; el server es la fuente de verdad con los ESTADOS REALES.
 * Cada página trae `{ items, nextCursor }`; `getNextPageParam` devuelve `nextCursor ?? undefined`
 * (undefined corta la paginación: `hasNextPage` pasa a false). El cursor es OPACO — lo re-pasamos tal
 * cual sin parsearlo. Al llegar al fondo de la lista, la pantalla llama `fetchNextPage`.
 *
 * Sin fallback a MMKV a propósito (HONESTO): si no hay red, mostramos error reintentable, NO la foto
 * vieja como si fuera verdad. El snapshot local sigue vivo solo para recents + la polyline del detalle.
 */
export function useTripHistory(): UseTripHistoryResult {
  const getTripHistory = useDependency(TOKENS.getTripHistoryUseCase);

  const query: UseInfiniteQueryResult<{ pages: TripHistoryPage[] }, Error> = useInfiniteQuery({
    queryKey: tripHistoryKey,
    queryFn: ({ pageParam }) =>
      getTripHistory.execute({ cursor: pageParam ?? undefined, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // `null` (sin más) → undefined corta la paginación; un cursor opaco se re-pasa tal cual.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isRefetching: query.isRefetching,
    fetchNextPage: () => {
      // Solo pide si hay más y no hay una página en vuelo (evita disparos dobles al llegar al fondo).
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
}
