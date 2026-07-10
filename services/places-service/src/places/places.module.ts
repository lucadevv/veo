import { Module } from '@nestjs/common';
import { PlacesService } from './places.service';
import { PLACES_REPO, PrismaPlacesRepository } from './places.repository';

/**
 * Módulo de lugares guardados. Expone PlacesService (reglas de negocio) al controlador gRPC,
 * que vive en el AppModule (como en identity/share) para mantener el patrón del repo.
 * El acceso a Prisma vive tras el puerto PLACES_REPO (unit-of-work · FOUNDATION §10): el service
 * depende de la interfaz, no del cliente.
 */
@Module({
  providers: [
    PlacesService,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: PLACES_REPO, useClass: PrismaPlacesRepository },
  ],
  exports: [PlacesService],
})
export class PlacesModule {}
