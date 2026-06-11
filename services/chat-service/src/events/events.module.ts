import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { ErasureConsumer } from './erasure.consumer';

@Module({
  imports: [ChatModule],
  providers: [ErasureConsumer],
})
export class EventsModule {}
