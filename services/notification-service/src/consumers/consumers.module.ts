import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { DevicesModule } from '../devices/devices.module';
import { SupportModule } from '../support/support.module';
import { ShareContactsModule } from '../ports/share/share.module';
import { EventConsumerService } from './event-consumer.service';
import { UserDeletedConsumer } from './user-deleted.consumer';

@Module({
  // ShareContactsModule: gRPC a share-service para resolver teléfonos de contactos en el fan-out de pánico.
  imports: [EngineModule, DevicesModule, SupportModule, ShareContactsModule],
  providers: [EventConsumerService, UserDeletedConsumer],
})
export class ConsumersModule {}
