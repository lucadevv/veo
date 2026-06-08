import { Module } from '@nestjs/common';
import { DispatchModule } from '../dispatch/dispatch.module';
import { HeatmapModule } from '../heatmap/heatmap.module';
import { KafkaConsumersService } from './kafka-consumers.service';

@Module({
  imports: [DispatchModule, HeatmapModule],
  providers: [KafkaConsumersService],
})
export class MessagingModule {}
