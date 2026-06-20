import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { DriverVehiclesController } from './driver-vehicles.controller';
import { VehicleModelsModule } from '../vehicle-models/vehicle-models.module';

@Module({
  // LOTE 3 · el alta a TEXTO LIBRE (OCR) hace fuzzy-match contra el catálogo y, sin match, encola el modelo
  // (requestModel source=OCR). Reusa VehicleModelsService — por eso se importa su módulo (que lo exporta).
  imports: [VehicleModelsModule],
  providers: [VehiclesService],
  controllers: [VehiclesController, DriverVehiclesController],
  exports: [VehiclesService],
})
export class VehiclesModule {}
