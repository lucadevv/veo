import {type HttpClient, promoValidationView} from '@veo/api-client';
import type {PromoValidationView} from '../domain/entities';
import type {PromosRepository} from '../domain/promosRepository';

/**
 * Implementación REAL de `PromosRepository` contra el public-bff (`POST /promos/validate`, Ola 2A).
 * Valida la respuesta con el schema SOBERANO `promoValidationView` de `@veo/api-client`.
 */
export class HttpPromosRepository implements PromosRepository {
  constructor(private readonly http: HttpClient) {}

  validate(code: string, fareCents: number): Promise<PromoValidationView> {
    return this.http.post('/promos/validate', {
      body: {code, fareCents},
      schema: promoValidationView,
    });
  }
}
