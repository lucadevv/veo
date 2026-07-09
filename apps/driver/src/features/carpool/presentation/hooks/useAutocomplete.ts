import type { MapPoint, PlaceSuggestionList } from '@veo/api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRepositories } from '../../../../core/di/useDi';
import { AutocompletePlacesUseCase, MAPS_QUERY_KEY, MIN_QUERY_LENGTH } from '../../../maps/domain';

/** Retardo del debounce del autocompletado (ms). Espeja al de mapas/pasajero. */
const DEBOUNCE_MS = 250;

export interface UseAutocompleteResult {
  suggestions: PlaceSuggestionList;
  loading: boolean;
  error: boolean;
  /** True si la consulta ya alcanzó la longitud mínima para buscar. */
  active: boolean;
}

/**
 * Autocompletado de direcciones para el publicador de carpool. Envuelve el caso de uso público
 * `AutocompletePlacesUseCase` (maps/domain) sobre el namespace COMPARTIDO `MAPS_QUERY_KEY`: MISMO cache
 * que `maps/presentation` (coherente), SIN importar sus hooks internos (feature-isolation). Debounce
 * (~250ms) + sesgo por ubicación (`near`); no llama al bff hasta la longitud mínima.
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
