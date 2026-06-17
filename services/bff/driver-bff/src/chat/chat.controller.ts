import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { ChatMessage } from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { ChatService } from './chat.service';
import { ListMessagesQueryDto, SendMessageDto } from './dto/chat.dto';

@ApiTags('chat')
@DriverApi()
@Controller('trips/:tripId/messages')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ApiOperation({ summary: 'Historial de chat del viaje del conductor (Ola 2A)' })
  list(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query() query: ListMessagesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChatMessage[]> {
    return this.chat.list(user, tripId, query.limit);
  }

  @Post()
  @ApiOperation({
    summary: 'Enviar un mensaje al pasajero (viaje activo). Persiste + emite por socket',
  })
  send(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChatMessage> {
    return this.chat.send(user, tripId, dto.body);
  }
}
