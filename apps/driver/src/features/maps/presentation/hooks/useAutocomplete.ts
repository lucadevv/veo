import type { MapPoint, PlaceSuggestionList } from '@veo/api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRepositories } from '../../../../core/di/useDi';
import { AutocompletePlacesUseCase, MIN_QUERY_LENGTH } from '../../domain';

/** Retardo del debounce del autocompletado (ms). Espeja al pasajero. */
const DEBOUNCE_MS = 250;

/** Clave raíz del namespace de mapas en la caché de react-query. */
export const MAPS_QUERY_KEY = ['maps'] as const;

export interface UseAutocompleteResult {
  suggestions: PlaceSuggestionList;
  loading: boolean;
  error: boolean;
  /** True si la consulta ya alcanzó la longitud mínima para buscar. */
  active: boolean;
}

/**
 * Autocompletado de direcciones con debounce (~250ms) y sesgo por ubicación (`near`). Resuelve el
 * repositorio de mapas por DI (`useRepositories().maps`) y delega el cacheo/estado de servidor a React
 * Query. No llama al bff hasta que la consulta alcanza la longitud mínima (regla aplicada también en el
 * caso de uso). Espejo EXACTO del hook del pasajero, adaptado al DI del conductor.
 */
export function useAutocomplete(query: string, near?: MapPoint | null): UseAutocompleteResult {
  const { maps } = useRepositories();
  const [debounced, setDebounced] = useState(query);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const trimmed = debounced.trim();
  const active = trimmed.length >= MIN_QUERY_LENGTH;

  const suggestionsQuery = useQuery({
    queryKey: [...MAPS_QUERY_KEY, 'autocomplete', trimmed, near?.lat ?? null, near?.lng ?? null],
    queryFn: () => new AutocompletePlacesUseCase(maps).execute(trimmed, near ?? undefined),
    enabled: active,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  return {
    suggestions: suggestionsQuery.data ?? [],
    loading: active && suggestionsQuery.isFetching,
    error: suggestionsQuery.isError,
    active,
  };
}
