import type {CreateTicketInput, SupportTicketListView, SupportTicketView} from '../entities';

/**
 * Contrato del repositorio de soporte (capa domain). Implementación concreta en `data/`.
 * Ambos endpoints son del driver-bff con JWT del conductor; el BFF fija userId/role.
 */
export interface SupportRepository {
  /** POST /support/tickets — crea un ticket y devuelve el creado. */
  createTicket(input: CreateTicketInput): Promise<SupportTicketView>;
  /** GET /support/tickets — tickets del conductor, más recientes primero. */
  listTickets(): Promise<SupportTicketListView>;
}
