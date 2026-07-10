import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { CHAT_REPO, PrismaChatRepository } from './chat.repository';

@Module({
  providers: [ChatService, { provide: CHAT_REPO, useClass: PrismaChatRepository }],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}
