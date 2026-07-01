import { Module } from '@nestjs/common';
import { MapsController } from './maps.controller';
import { MapsService } from './maps.service';

/**
 * Módulo de búsqueda de lugares del conductor. El cliente MAPS (@veo/maps) lo provee CoreModule
 * (@Global), así que acá solo declaramos el controller + service (mismo patrón que carpool/earnings).
 */
@Module({
  controllers: [MapsController],
  providers: [MapsService],
})
export class MapsModule {}
