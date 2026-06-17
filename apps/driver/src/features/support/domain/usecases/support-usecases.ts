import type { SupportRepository } from '../repositories/support-repository';
import type { SupportTicketListView, SupportTicketView } from '../entities';
import {
  isTicketDraftValid,
  toCreateTicketInput,
  type TicketDraft,
} from '../value-objects/ticket-draft';

/** Error de validación del borrador de ticket (asunto/cuerpo no cumplen longitudes). */
export class InvalidTicketDraftError extends Error {
  constructor() {
    super('El ticket de soporte no es válido');
    this.name = 'InvalidTicketDraftError';
  }
}

/**
 * Caso de uso: crear un ticket de soporte a partir de un borrador. Valida en el dominio antes de
 * tocar la red (defensa además del bloqueo del formulario) y normaliza al cuerpo del contrato.
 */
export class CreateTicketUseCase {
  constructor(private readonly support: SupportRepository) {}

  execute(draft: TicketDraft): Promise<SupportTicketView> {
    if (!isTicketDraftValid(draft)) {
      throw new InvalidTicketDraftError();
    }
    return this.support.createTicket(toCreateTicketInput(draft));
  }
}

/** Caso de uso: listar los tickets del conductor (más recientes primero, según el server). */
export class ListTicketsUseCase {
  constructor(private readonly support: SupportRepository) {}

  execute(): Promise<SupportTicketListView> {
    return this.support.listTickets();
  }
}
