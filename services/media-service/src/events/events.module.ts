import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { MediaEventConsumer } from './media.consumer';
import { ErasureConsumer } from './erasure.consumer';

@Module({
  imports: [MediaModule],
  providers: [MediaEventConsumer, ErasureConsumer],
})
export class EventsModule {}
