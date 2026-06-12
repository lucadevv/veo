import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import { EventsConsumer } from '../consumers/events.consumer';
import { ShareService } from './share.service';
import { ShareController } from './share.controller';
import { PublicShareController } from './public-share.controller';

@Module({
  // El consumer de pánico YA NO manda SMS inline (delega a notification por evento); el puerto SMS
  // queda para el OTP de contactos, importado por ContactsModule (su único uso vivo).
  imports: [ContactsModule],
  providers: [ShareService, TripSnapshotService, EventsConsumer],
  controllers: [ShareController, PublicShareController],
  exports: [ShareService],
})
export class ShareModule {}
