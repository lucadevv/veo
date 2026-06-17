import type {MapPoint, PlaceSuggestionList} from '@veo/api-client';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {useEffect, useState} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {MIN_QUERY_LENGTH} from '../../domain/entities';

/** Retardo del debounce del autocompletado (ms). */
const DEBOUNCE_MS = 250;

export interface UseAutocompleteResult {
  suggestions: PlaceSuggestionList;
  loading: boolean;
  error: boolean;
  /** True si la consulta ya alcanzó la longitud mínima para buscar. */
  active: boolean;
}

/**
 * Autocompletado de direcciones con debounce (~250ms) y sesgo por ubicación (`near`). Resuelve el
 * caso de uso por DI y delega el cacheo/estado de servidor a React Query. No llama al bff hasta que
 * la consulta alcanza la longitud mínima (regla aplicada también en el caso de uso).
 */
export function useAutocomplete(
  query: string,
  near?: MapPoint | null,
): UseAutocompleteResult {
  const autocomplete = useDependency(TOKENS.autocompletePlacesUseCase);
  const [debounced, setDebounced] = useState(query);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const trimmed = debounced.trim();
  const active = trimmed.length >= MIN_QUERY_LENGTH;

  const suggestionsQuery = useQuery({
    queryKey: [
      'maps',
      'autocomplete',
      trimmed,
      near?.lat ?? null,
      near?.lng ?? null,
    ],
    queryFn: () => autocomplete.execute(trimmed, near ?? undefined),
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
