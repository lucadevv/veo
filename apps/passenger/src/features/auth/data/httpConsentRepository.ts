import {
  type ConsentRecorded,
  consentRecorded,
  type CurrentConsent,
  currentConsent,
  type HttpClient,
  type RecordConsentRequest,
} from '@veo/api-client';
import type {ConsentRepository} from '../domain/consentRepository';

/** Implementación de `ConsentRepository` contra el public-bff (GET/POST /users/me/consents). */
export class HttpConsentRepository implements ConsentRepository {
  constructor(private readonly http: HttpClient) {}

  record(input: RecordConsentRequest): Promise<ConsentRecorded> {
    return this.http.post('/users/me/consents', {
      body: input,
      schema: consentRecorded,
    });
  }

  getCurrent(): Promise<CurrentConsent> {
    return this.http.get('/users/me/consents', {schema: currentConsent});
  }
}
