import { Module } from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { DispatchController } from './dispatch.controller';

@Module({
  controllers: [DispatchController],
  providers: [DispatchService],
  // ADR-021 Fase C — TripsService reusa getSurge para re-cotizar el surge AUTORITATIVO server-side.
  exports: [DispatchService],
})
export class DispatchModule {}
