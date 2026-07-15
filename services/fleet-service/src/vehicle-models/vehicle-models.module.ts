import { Module } from '@nestjs/common';
import { VehicleModelsService } from './vehicle-models.service';
import { VehicleModelsController } from './vehicle-models.controller';
import { VEHICLE_MODELS_REPO, PrismaVehicleModelsRepository } from './vehicle-models.repository';

@Module({
  // §10: VEHICLE_MODELS_REPO es el único dueño de Prisma del feature; el service depende de la interfaz.
  providers: [
    VehicleModelsService,
    { provide: VEHICLE_MODELS_REPO, useClass: PrismaVehicleModelsRepository },
  ],
  controllers: [VehicleModelsController],
  exports: [VehicleModelsService],
})
export class VehicleModelsModule {}
