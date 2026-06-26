import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { DevicesModule } from '../devices/devices.module';
import { SupportModule } from '../support/support.module';
import { ShareContactsModule } from '../ports/share/share.module';
import { IdentityModule } from '../ports/identity/identity.module';
import { EventConsumerService } from './event-consumer.service';
import { UserDeletedConsumer } from './user-deleted.consumer';

@Module({
  // ShareContactsModule: gRPC a share-service para resolver teléfonos de contactos en el fan-out de pánico.
  // IdentityModule: gRPC a identity para resolver driverId→userId en los pushes que targetean al conductor
  // por su Driver.id (ADR-015 D7 · payout.processed) antes del lookup de device-token.
  imports: [EngineModule, DevicesModule, SupportModule, ShareContactsModule, IdentityModule],
  providers: [EventConsumerService, UserDeletedConsumer],
})
export class ConsumersModule {}
