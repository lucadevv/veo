import { Module } from '@nestjs/common';
import { DriverGateway } from './driver.gateway';
import { KafkaConsumerService } from './kafka-consumer.service';
import { LocationPublisherService } from './location-publisher.service';
import { ActiveVehicleTypeResolver } from './active-vehicle-type.resolver';

@Module({
  providers: [
    DriverGateway,
    KafkaConsumerService,
    LocationPublisherService,
    ActiveVehicleTypeResolver,
  ],
  exports: [DriverGateway, ActiveVehicleTypeResolver],
})
export class RealtimeModule {}
