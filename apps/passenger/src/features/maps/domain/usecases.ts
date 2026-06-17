import type {
  CatalogResult,
  MapPoint,
  PlaceSuggestionList,
  QuoteRequest,
  QuoteResult,
  ReversePlace,
} from '@veo/api-client';
import { MIN_QUERY_LENGTH } from './entities';
import type { MapsRepository } from './mapsRepository';

/**
 * Autocompleta direcciones. Aplica la regla de negocio de longitud mínima ANTES de tocar la red
 * (SRP): si la consulta tiene menos de `MIN_QUERY_LENGTH` caracteres útiles, devuelve [] sin llamar.
 */
export class AutocompletePlacesUseCase {
  constructor(private readonly repository: MapsRepository) {}

  execute(query: string, near?: MapPoint): Promise<PlaceSuggestionList> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return Promise.resolve([]);
    }
    return this.repository.autocomplete(trimmed, near);
  }
}

/** Geocoding inverso: etiqueta legible de un punto (p. ej. para nombrar la ubicación actual). */
export class ReverseGeocodeUseCase {
  constructor(private readonly repository: MapsRepository) {}

  execute(point: MapPoint): Promise<ReversePlace> {
    return this.repository.reverse(point);
  }
}

/** Cotiza la ruta entre origen y destino (precio + ETA por categoría + geometría real). */
export class QuoteRideUseCase {
  constructor(private readonly repository: MapsRepository) {}

  execute(request: QuoteRequest): Promise<QuoteResult> {
    return this.repository.quote(request);
  }
}

/** Catálogo ACTIVO de ofertas (server-driven · B1f): las que el admin tiene habilitadas, para la teaser. */
export class GetCatalogUseCase {
  constructor(private readonly repository: MapsRepository) {}

  execute(): Promise<CatalogResult> {
    return this.repository.catalog();
  }
}
