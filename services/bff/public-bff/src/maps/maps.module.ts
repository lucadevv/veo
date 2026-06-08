import { Module } from '@nestjs/common';
import { MapsService } from './maps.service';
import { MapsController } from './maps.controller';

/** Búsqueda de direcciones, reverse geocoding y cotización de previsualización (OSRM/Nominatim). */
@Module({
  controllers: [MapsController],
  providers: [MapsService],
})
export class MapsModule {}
