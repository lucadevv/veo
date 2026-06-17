import {
  type CatalogResult,
  catalogResult,
  type HttpClient,
  type MapPoint,
  type PlaceSuggestionList,
  placeSuggestionList,
  type QuoteRequest,
  type QuoteResult,
  quoteResult,
  type ReversePlace,
  reversePlace,
} from '@veo/api-client';
import type {MapsRepository} from '../domain/mapsRepository';

/** Implementación de `MapsRepository` contra el public-bff (`/maps/*`). */
export class HttpMapsRepository implements MapsRepository {
  constructor(private readonly http: HttpClient) {}

  autocomplete(query: string, near?: MapPoint): Promise<PlaceSuggestionList> {
    return this.http.get('/maps/autocomplete', {
      query: {
        q: query,
        ...(near ? {lat: near.lat, lng: near.lng} : {}),
      },
      schema: placeSuggestionList,
    });
  }

  reverse(point: MapPoint): Promise<ReversePlace> {
    return this.http.get('/maps/reverse', {
      query: {lat: point.lat, lng: point.lng},
      schema: reversePlace,
    });
  }

  quote(request: QuoteRequest): Promise<QuoteResult> {
    return this.http.post('/maps/quote', {body: request, schema: quoteResult});
  }

  catalog(): Promise<CatalogResult> {
    return this.http.get('/maps/catalog', {schema: catalogResult});
  }
}
