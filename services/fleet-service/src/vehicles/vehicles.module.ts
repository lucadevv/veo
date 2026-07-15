import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { DriverVehiclesController } from './driver-vehicles.controller';
import { OperableVehicleClassesProvider } from './operable-vehicle-classes.provider';
import { VEHICLES_REPO, PrismaVehiclesRepository } from './vehicles.repository';
import { VehicleModelsModule } from '../vehicle-models/vehicle-models.module';

@Module({
  // LOTE 3 · el alta a TEXTO LIBRE (OCR) hace fuzzy-match contra el catálogo y, sin match, encola el modelo
  // (requestModel source=OCR). Reusa VehicleModelsService — por eso se importa su módulo (que lo exporta).
  imports: [VehicleModelsModule],
  // OperableVehicleClassesProvider: gate de operabilidad overlay-aware (lee el catálogo efectivo de
  // trip-service vía el cliente TRIP_REST exportado por CoreModule global).
  // VEHICLES_REPO (§10): el único dueño de Prisma del feature; el service depende de la interfaz.
  providers: [
    VehiclesService,
    OperableVehicleClassesProvider,
    { provide: VEHICLES_REPO, useClass: PrismaVehiclesRepository },
  ],
  controllers: [VehiclesController, DriverVehiclesController],
  exports: [VehiclesService],
})
export class VehiclesModule {}
