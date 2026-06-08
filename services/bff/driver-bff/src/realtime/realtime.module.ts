import { Module } from '@nestjs/common';
import { DriverGateway } from './driver.gateway';
import { KafkaConsumerService } from './kafka-consumer.service';
import { LocationPublisherService } from './location-publisher.service';

@Module({
  providers: [DriverGateway, KafkaConsumerService, LocationPublisherService],
  exports: [DriverGateway],
})
export class RealtimeModule {}
