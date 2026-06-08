/**
 * Endpoints internos de chat (los llaman public-bff y driver-bff por REST firmado tras validar la
 * membresía del usuario en el viaje y que el viaje esté activo). InternalIdentityGuard.
 *  - GET  /chat/trips/:tripId/messages → historial.
 *  - POST /chat/trips/:tripId/messages → persiste y devuelve el mensaje (el BFF lo emite por socket).
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { ChatService, type ChatMessageView } from './chat.service';
import { ListMessagesQueryDto, PostMessageDto } from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('chat/trips/:tripId/messages')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ApiOperation({ summary: 'Historial de mensajes del viaje (orden cronológico ascendente)' })
  list(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<ChatMessageView[]> {
    return this.chat.listMessages(tripId, query.limit);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Persistir un mensaje del viaje' })
  post(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: PostMessageDto,
  ): Promise<ChatMessageView> {
    return this.chat.postMessage({
      tripId,
      senderId: dto.senderId,
      senderRole: dto.senderRole,
      body: dto.body,
      passengerId: dto.passengerId,
    });
  }
}
