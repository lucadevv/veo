import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportTicketRepository } from './support.repository';

/**
 * Centro de ayuda/soporte (Ola 2C). Vive en notification-service (bounded context de comunicaciones
 * con el usuario): reusa su Postgres, Prisma y el InternalIdentityGuard. Tickets simples (sin FAQ:
 * la FAQ es estática del lado app).
 */
@Module({
  controllers: [SupportController],
  providers: [SupportService, SupportTicketRepository],
})
export class SupportModule {}
