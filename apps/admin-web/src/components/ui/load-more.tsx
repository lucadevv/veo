'use client';

import { Button } from './button';

interface LoadMoreProps {
  /** ¿Hay más páginas? (de useInfiniteQuery.hasNextPage) */
  hasNextPage: boolean;
  /** ¿Cargando la siguiente página? (isFetchingNextPage) */
  isFetching: boolean;
  onLoadMore: () => void;
}

/** Botón "Cargar más" para listas paginadas por cursor (useInfiniteQuery). Se oculta si no hay más. */
export function LoadMore({ hasNextPage, isFetching, onLoadMore }: LoadMoreProps) {
  if (!hasNextPage) return null;
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="secondary" loading={isFetching} onClick={onLoadMore}>
        Cargar más
      </Button>
    </div>
  );
}
