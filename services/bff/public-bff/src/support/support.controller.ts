import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { SupportTicket } from '@veo/api-client';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/support.dto';

@ApiTags('support')
@ApiBearerAuth()
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un ticket de soporte (pasajero)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTicketDto,
  ): Promise<SupportTicket> {
    return this.support.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar mis tickets de soporte (más recientes primero)' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<SupportTicket[]> {
    return this.support.list(user);
  }
}
