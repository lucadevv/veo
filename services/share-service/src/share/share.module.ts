import { Module, type Provider } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import {
  TRIP_SNAPSHOT_REPO,
  PrismaTripSnapshotRepository,
} from '../read-model/trip-snapshot.repository';
import { EventsConsumer } from '../consumers/events.consumer';
import { ShareService } from './share.service';
import { SHARE_REPO, PrismaShareRepository } from './share.repository';
import { ShareController } from './share.controller';
import { PublicShareController } from './public-share.controller';

// FOUNDATION §10: cada service accede a Prisma SOLO por su puerto (unit-of-work), nunca `this.prisma`.
const shareRepoProvider: Provider = { provide: SHARE_REPO, useClass: PrismaShareRepository };
const tripSnapshotRepoProvider: Provider = {
  provide: TRIP_SNAPSHOT_REPO,
  useClass: PrismaTripSnapshotRepository,
};

@Module({
  // El consumer de pánico YA NO manda SMS inline (delega a notification por evento); el puerto SMS
  // queda para el OTP de contactos, importado por ContactsModule (su único uso vivo).
  imports: [ContactsModule],
  providers: [
    ShareService,
    TripSnapshotService,
    EventsConsumer,
    shareRepoProvider,
    tripSnapshotRepoProvider,
  ],
  controllers: [ShareController, PublicShareController],
  exports: [ShareService],
})
export class ShareModule {}
