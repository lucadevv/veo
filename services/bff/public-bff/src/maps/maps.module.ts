import { Module } from '@nestjs/common';
import { MapsService } from './maps.service';
import { MapsController } from './maps.controller';
import { DispatchModule } from '../dispatch/dispatch.module';

/** Búsqueda de direcciones, reverse geocoding y cotización de previsualización (OSRM/Nominatim). */
@Module({
  // ADR-021 Fase C — DispatchModule expone DispatchService para resolver el surge autoritativo del quote
  // (mismo getSurge que usa el create), y así el preview FIXED muestre el surge que se va a cobrar.
  imports: [DispatchModule],
  controllers: [MapsController],
  providers: [MapsService],
})
export class MapsModule {}
