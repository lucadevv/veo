import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { DriverVehiclesController } from './driver-vehicles.controller';

@Module({
  providers: [VehiclesService],
  controllers: [VehiclesController, DriverVehiclesController],
  exports: [VehiclesService],
})
export class VehiclesModule {}
