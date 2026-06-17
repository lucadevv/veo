import { Module } from '@nestjs/common';
import { VehicleModelsService } from './vehicle-models.service';
import { VehicleModelsController } from './vehicle-models.controller';

@Module({
  providers: [VehicleModelsService],
  controllers: [VehicleModelsController],
  exports: [VehicleModelsService],
})
export class VehicleModelsModule {}
