import type {CreateTicketRequest, SupportTicket} from '@veo/api-client';

/** Abstracción del repositorio de Soporte (DIP). */
export interface SupportRepository {
  /** POST /support/tickets → crea un ticket de soporte y devuelve el creado. */
  createTicket(input: CreateTicketRequest): Promise<SupportTicket>;
  /** GET /support/tickets → tickets del usuario autenticado (más recientes primero). */
  listTickets(): Promise<SupportTicket[]>;
}
