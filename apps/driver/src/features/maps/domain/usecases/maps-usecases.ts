import type { MapPoint, PlaceSuggestionList } from '@veo/api-client';
import { MIN_QUERY_LENGTH } from '../entities';
import type { MapsRepository } from '../repositories/maps-repository';

/**
 * Autocompleta direcciones. Aplica la regla de negocio de longitud mínima ANTES de tocar la red (SRP):
 * si la consulta tiene menos de `MIN_QUERY_LENGTH` caracteres útiles, devuelve [] sin llamar. Espeja al
 * pasajero.
 */
export class AutocompletePlacesUseCase {
  constructor(private readonly maps: MapsRepository) {}

  execute(query: string, near?: MapPoint): Promise<PlaceSuggestionList> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return Promise.resolve([]);
    }
    return this.maps.autocomplete(trimmed, near);
  }
}
