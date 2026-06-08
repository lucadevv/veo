/**
 * SupportTicketRepository — almacén de tickets de soporte (Ola 2C). Crear y listar por usuario.
 * `userId`/`role` los fija el llamante desde la identidad firmada; nunca se confían del cuerpo.
 */
import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import type { SupportCategory, SupportRole, SupportTicket } from '../generated/prisma';

export interface CreateTicketInput {
  userId: string;
  role: SupportRole;
  category: SupportCategory;
  subject: string;
  body: string;
  tripId?: string;
}

@Injectable()
export class SupportTicketRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateTicketInput): Promise<SupportTicket> {
    return this.prisma.write.supportTicket.create({
      data: {
        id: uuidv7(),
        userId: input.userId,
        role: input.role,
        category: input.category,
        subject: input.subject,
        body: input.body,
        tripId: input.tripId ?? null,
      },
    });
  }

  /** Tickets del usuario (más recientes primero). */
  findByUser(userId: string): Promise<SupportTicket[]> {
    return this.prisma.read.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
