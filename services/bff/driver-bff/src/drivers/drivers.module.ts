import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

@Module({
  // RealtimeModule exporta ActiveVehicleTypeResolver: setActiveVehicle invalida su cache tras el swap
  // (ADR-017 §5(d) d.2). No hay ciclo — RealtimeModule no depende de DriversModule.
  imports: [RealtimeModule],
  controllers: [DriversController],
  providers: [DriversService],
})
export class DriversModule {}
