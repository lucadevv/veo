import { Module } from '@nestjs/common';
import { SmsModule } from '../ports/sms/sms.module';
import { ContactsModule } from '../contacts/contacts.module';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import { EventsConsumer } from '../consumers/events.consumer';
import { ShareService } from './share.service';
import { ShareController } from './share.controller';
import { PublicShareController } from './public-share.controller';

@Module({
  imports: [SmsModule, ContactsModule],
  providers: [ShareService, TripSnapshotService, EventsConsumer],
  controllers: [ShareController, PublicShareController],
  exports: [ShareService],
})
export class ShareModule {}
