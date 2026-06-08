import type {HttpClient} from '@veo/api-client';
import { supportTicket, supportTicketList} from '@veo/api-client';
import type {
  CreateTicketInput,
  SupportRepository,
  SupportTicketListView,
  SupportTicketView,
} from '../../domain';

/** Implementación HTTP del `SupportRepository` contra el driver-bff. */
export class HttpSupportRepository implements SupportRepository {
  constructor(private readonly http: HttpClient) {}

  createTicket(input: CreateTicketInput): Promise<SupportTicketView> {
    return this.http.post('/support/tickets', {body: input, schema: supportTicket});
  }

  listTickets(): Promise<SupportTicketListView> {
    return this.http.get('/support/tickets', {schema: supportTicketList});
  }
}
