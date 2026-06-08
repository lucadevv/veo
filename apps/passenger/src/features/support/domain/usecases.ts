import type {
  CreateTicketRequest,
  SupportCategory,
  SupportStatus,
  SupportTicket,
} from '@veo/api-client';
import {
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  MIN_BODY_LENGTH,
  MIN_SUBJECT_LENGTH,
} from './entities';
import type { SupportRepository } from './supportRepository';

/** Campo del formulario que falló la validación (mapea a una clave i18n de error). */
export type TicketField = 'subject' | 'body';

/** Error de dominio para un ticket inválido antes de tocar la red. */
export class TicketValidationError extends Error {
  constructor(readonly field: TicketField) {
    super(`Ticket de soporte inválido: ${field}`);
    this.name = 'TicketValidationError';
  }
}

/** Entrada cruda del formulario (sin recortar). El BFF fija userId/role desde la identidad. */
export interface CreateTicketInput {
  category: SupportCategory;
  subject: string;
  body: string;
  tripId?: string;
}

/**
 * Crea un ticket de soporte (POST /support/tickets). Valida en dominio antes de la red (SRP):
 * asunto y mensaje con longitudes dentro de rango. Recorta espacios y adjunta el tripId solo si
 * la pantalla lo proporcionó.
 */
export class CreateTicketUseCase {
  constructor(private readonly repository: SupportRepository) {}

  execute(input: CreateTicketInput): Promise<SupportTicket> {
    const subject = input.subject.trim();
    const body = input.body.trim();

    if (subject.length < MIN_SUBJECT_LENGTH || subject.length > MAX_SUBJECT_LENGTH) {
      throw new TicketValidationError('subject');
    }
    if (body.length < MIN_BODY_LENGTH || body.length > MAX_BODY_LENGTH) {
      throw new TicketValidationError('body');
    }

    const request: CreateTicketRequest = {
      category: input.category,
      subject,
      body,
      ...(input.tripId ? { tripId: input.tripId } : {}),
    };
    return this.repository.createTicket(request);
  }
}

/** Lista los tickets de soporte del pasajero (GET /support/tickets). */
export class ListTicketsUseCase {
  constructor(private readonly repository: SupportRepository) {}

  execute(): Promise<SupportTicket[]> {
    return this.repository.listTickets();
  }
}

/** Tono semántico (ui-kit) para el chip de estado de un ticket. */
export type TicketStatusTone = 'warn' | 'accent' | 'success';

/** Mapea el estado del ciclo de vida a un tono del StatusPill. */
export function ticketStatusTone(status: SupportStatus): TicketStatusTone {
  switch (status) {
    case 'OPEN':
      return 'warn';
    case 'IN_PROGRESS':
      return 'accent';
    case 'RESOLVED':
      return 'success';
  }
}
