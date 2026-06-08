import { Module } from '@nestjs/common';
import { PlacesService } from './places.service';
import { PlacesController } from './places.controller';

/** Lugares guardados del pasajero (Lote B). REST → gRPC sobre places-service. */
@Module({
  controllers: [PlacesController],
  providers: [PlacesService],
})
export class PlacesModule {}
