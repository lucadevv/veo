import type {PlaceSuggestion} from '@veo/api-client';
import type {RoutePlace} from '../../../maps/domain/entities';
import type {SavedPlace} from '../../../places/domain/entities';

/** Convierte un lugar guardado en el `RoutePlace` que consume el borrador. */
export function placeToRoute(place: SavedPlace): RoutePlace {
  return {
    point: place.point,
    title: place.label,
    ...(place.subtitle ? {subtitle: place.subtitle} : {}),
  };
}

/** Convierte una sugerencia de autocompletado en el `RoutePlace` que consume el borrador. */
export function suggestionToRoute(suggestion: PlaceSuggestion): RoutePlace {
  return {
    point: {lat: suggestion.lat, lng: suggestion.lng},
    title: suggestion.title,
    subtitle: suggestion.subtitle,
  };
}
