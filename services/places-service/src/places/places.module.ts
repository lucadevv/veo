import { Module } from '@nestjs/common';
import { PlacesService } from './places.service';

/**
 * Módulo de lugares guardados. Expone PlacesService (reglas de negocio) al controlador gRPC,
 * que vive en el AppModule (como en identity/share) para mantener el patrón del repo.
 */
@Module({
  providers: [PlacesService],
  exports: [PlacesService],
})
export class PlacesModule {}
