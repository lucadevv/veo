import { Module } from '@nestjs/common';
import { TripsService } from './trips.service';
import { TripsController } from './trips.controller';
import { DriverEnrichmentService } from './driver-enrichment.service';
import { DispatchModule } from '../dispatch/dispatch.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  // ADR-021 Fase C — DispatchModule expone DispatchService para re-cotizar el surge autoritativo.
  // RealtimeModule — la ruta por fase del pasajero (:id/route) traza desde la ÚLTIMA ubicación
  // conocida del CONDUCTOR, que vive en RealtimeStateService (poblada por el consumer Kafka).
  imports: [DispatchModule, RealtimeModule],
  controllers: [TripsController],
  providers: [TripsService, DriverEnrichmentService],
})
export class TripsModule {}
