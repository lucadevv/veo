/**
 * Centro de ayuda/soporte (lado pasajero, Ola 2C). Proxy firmado a notification-service
 * (`/internal/support/tickets`), que persiste y lista los tickets. El `userId`/`role` los deriva el
 * servicio downstream de la identidad firmada; aquí solo se reenvía el cuerpo.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { CreateTicketRequest, SupportTicket } from '@veo/api-client';
import { REST_NOTIFICATION } from '../infra/downstream.tokens';

@Injectable()
export class SupportService {
  constructor(@Inject(REST_NOTIFICATION) private readonly notificationRest: InternalRestClient) {}

  create(user: AuthenticatedUser, dto: CreateTicketRequest): Promise<SupportTicket> {
    return this.notificationRest.post<SupportTicket>('/internal/support/tickets', {
      identity: user,
      body: dto,
    });
  }

  list(user: AuthenticatedUser): Promise<SupportTicket[]> {
    return this.notificationRest.get<SupportTicket[]>('/internal/support/tickets', {
      identity: user,
    });
  }
}
