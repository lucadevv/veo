import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { MediaEventConsumer } from './media.consumer';
import { UserDeletedConsumer } from './user-deleted.consumer';
import { TripErasedConsumer } from './trip-erased.consumer';

@Module({
  imports: [MediaModule],
  providers: [MediaEventConsumer, UserDeletedConsumer, TripErasedConsumer],
})
export class EventsModule {}
