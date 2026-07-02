import { Module } from '@nestjs/common';
import { TripsService } from './trips.service';
import { TripsController } from './trips.controller';
import { DriverEnrichmentService } from './driver-enrichment.service';
import { DispatchModule } from '../dispatch/dispatch.module';

@Module({
  // ADR-021 Fase C — DispatchModule expone DispatchService para re-cotizar el surge autoritativo.
  imports: [DispatchModule],
  controllers: [TripsController],
  providers: [TripsService, DriverEnrichmentService],
})
export class TripsModule {}
