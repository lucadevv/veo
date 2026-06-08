/**
 * SupportService — lógica del centro de ayuda/soporte (Ola 2C). Crea tickets y lista los del usuario.
 * Mapea la entidad Prisma a la vista expuesta (fechas ISO-8601, tripId nullable).
 */
import { Injectable } from '@nestjs/common';
import { SupportTicketRepository, type CreateTicketInput } from './support.repository';
import type { SupportTicket } from '../generated/prisma';

export interface SupportTicketView {
  id: string;
  userId: string;
  role: 'PASSENGER' | 'DRIVER';
  category: string;
  subject: string;
  body: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  tripId: string | null;
  createdAt: string;
}

@Injectable()
export class SupportService {
  constructor(private readonly repo: SupportTicketRepository) {}

  async create(input: CreateTicketInput): Promise<SupportTicketView> {
    const ticket = await this.repo.create(input);
    return SupportService.toView(ticket);
  }

  async listByUser(userId: string): Promise<SupportTicketView[]> {
    const tickets = await this.repo.findByUser(userId);
    return tickets.map((t) => SupportService.toView(t));
  }

  private static toView(t: SupportTicket): SupportTicketView {
    return {
      id: t.id,
      userId: t.userId,
      role: t.role,
      category: t.category,
      subject: t.subject,
      body: t.body,
      status: t.status,
      tripId: t.tripId,
      createdAt: t.createdAt.toISOString(),
    };
  }
}
