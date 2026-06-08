import {
  type HttpClient,
  type PanicTriggerRequest,
  type PanicTriggerResult,
  panicTriggerResult,
  type PanicView,
  panicView,
} from '@veo/api-client';
import type { PanicRepository } from '../domain/panicRepository';

/** Implementación de `PanicRepository` contra el public-bff. */
export class HttpPanicRepository implements PanicRepository {
  constructor(private readonly http: HttpClient) {}

  trigger(input: PanicTriggerRequest): Promise<PanicTriggerResult> {
    // dedupKey garantiza idempotencia ante reintentos del native module / red.
    return this.http.post('/panic', {
      body: input,
      schema: panicTriggerResult,
      idempotencyKey: input.dedupKey,
    });
  }

  getPanic(panicId: string): Promise<PanicView> {
    return this.http.get(`/panic/${panicId}`, { schema: panicView });
  }
}
