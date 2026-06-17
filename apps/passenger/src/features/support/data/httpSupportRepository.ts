import {
  type CreateTicketRequest,
  type HttpClient,
  type SupportTicket,
  supportTicket,
  supportTicketList,
} from '@veo/api-client';
import type {SupportRepository} from '../domain/supportRepository';

/** Implementación de `SupportRepository` contra el public-bff (`/support/tickets`). */
export class HttpSupportRepository implements SupportRepository {
  constructor(private readonly http: HttpClient) {}

  createTicket(input: CreateTicketRequest): Promise<SupportTicket> {
    return this.http.post('/support/tickets', {
      body: input,
      schema: supportTicket,
    });
  }

  listTickets(): Promise<SupportTicket[]> {
    return this.http.get('/support/tickets', {schema: supportTicketList});
  }
}
