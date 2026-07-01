import type { HttpClient, MapPoint, PlaceSuggestionList, ReversePlace } from '@veo/api-client';
import { placeSuggestionList, reversePlace } from '@veo/api-client';
import type { MapsRepository } from '../../domain';

/** Implementación HTTP del `MapsRepository` contra el driver-bff (`/maps/*`). Espeja al pasajero. */
export class HttpMapsRepository implements MapsRepository {
  constructor(private readonly http: HttpClient) {}

  autocomplete(query: string, near?: MapPoint): Promise<PlaceSuggestionList> {
    return this.http.get('/maps/autocomplete', {
      query: {
        q: query,
        ...(near ? { lat: near.lat, lng: near.lng } : {}),
      },
      schema: placeSuggestionList,
    });
  }

  reverse(point: MapPoint): Promise<ReversePlace> {
    return this.http.get('/maps/reverse', {
      query: { lat: point.lat, lng: point.lng },
      schema: reversePlace,
    });
  }
}
