import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { DevicesModule } from '../devices/devices.module';
import { SupportModule } from '../support/support.module';
import { EventConsumerService } from './event-consumer.service';
import { UserDeletedConsumer } from './user-deleted.consumer';

@Module({
  imports: [EngineModule, DevicesModule, SupportModule],
  providers: [EventConsumerService, UserDeletedConsumer],
})
export class ConsumersModule {}
