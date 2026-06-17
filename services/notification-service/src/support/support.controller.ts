/**
 * Centro de ayuda/soporte (Ola 2C · interno). Protegido por InternalIdentityGuard: el BFF (público o
 * conductor) propaga la identidad firmada del usuario; el `userId`/`role` se toman de ahí (nunca del
 * cuerpo). La FAQ es estática del lado app; aquí solo viven los tickets que SÍ llegan al backend.
 *  - POST /internal/support/tickets → crear un ticket.
 *  - GET  /internal/support/tickets → listar los tickets del usuario autenticado.
 */
import { Body, Controller, ForbiddenException, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { SupportService, type SupportTicketView } from './support.service';
import { CreateTicketDto } from './dto/support.dto';
import type { SupportRole } from '../generated/prisma';

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un ticket de soporte (rol derivado de la identidad)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTicketDto,
  ): Promise<SupportTicketView> {
    return this.support.create({
      userId: user.userId,
      role: SupportController.roleOf(user),
      category: dto.category,
      subject: dto.subject,
      body: dto.body,
      tripId: dto.tripId,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Listar los tickets del usuario autenticado (más recientes primero)' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<SupportTicketView[]> {
    return this.support.listByUser(user.userId);
  }

  /** Deriva el rol del ticket del tipo de la identidad (passenger/driver). Rechaza admin. */
  private static roleOf(user: AuthenticatedUser): SupportRole {
    if (user.type === 'passenger') return 'PASSENGER';
    if (user.type === 'driver') return 'DRIVER';
    throw new ForbiddenException('Solo pasajeros y conductores pueden abrir tickets de soporte');
  }
}
