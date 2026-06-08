/**
 * Centro de ayuda/soporte (lado conductor, Ola 2C). Proxy firmado a notification-service
 * (`/internal/support/tickets`), que persiste y lista los tickets. El `userId`/`role` los deriva el
 * servicio downstream de la identidad firmada; aquí solo se reenvía el cuerpo.
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { CreateTicketRequest, SupportTicket } from '@veo/api-client';
import { RestGateway } from '../infra/rest.gateway';

@Injectable()
export class SupportService {
  constructor(private readonly rest: RestGateway) {}

  create(identity: AuthenticatedUser, dto: CreateTicketRequest): Promise<SupportTicket> {
    return this.rest.client('notification').post<SupportTicket>('/internal/support/tickets', {
      identity,
      body: dto,
    });
  }

  list(identity: AuthenticatedUser): Promise<SupportTicket[]> {
    return this.rest.client('notification').get<SupportTicket[]>('/internal/support/tickets', {
      identity,
    });
  }
}
