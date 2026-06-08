import { Module } from '@nestjs/common';
import { TripsService } from './trips.service';
import { TripsController } from './trips.controller';
import { DriverEnrichmentService } from './driver-enrichment.service';

@Module({
  controllers: [TripsController],
  providers: [TripsService, DriverEnrichmentService],
})
export class TripsModule {}
