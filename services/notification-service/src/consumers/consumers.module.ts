import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { DevicesModule } from '../devices/devices.module';
import { EventConsumerService } from './event-consumer.service';

@Module({
  imports: [EngineModule, DevicesModule],
  providers: [EventConsumerService],
})
export class ConsumersModule {}
