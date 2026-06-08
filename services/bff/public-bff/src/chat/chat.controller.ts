import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { ChatMessage } from '@veo/api-client';
import { ChatService } from './chat.service';
import { ListMessagesQueryDto, SendMessageDto } from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('trips/:tripId/messages')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ApiOperation({ summary: 'Historial de chat del viaje del pasajero (Ola 2A)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<ChatMessage[]> {
    return this.chat.list(user, tripId, query.limit);
  }

  @Post()
  @ApiOperation({ summary: 'Enviar un mensaje al conductor (viaje activo). Persiste + emite por socket' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.chat.send(user, tripId, dto.body);
  }
}
