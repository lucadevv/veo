import { Module } from '@nestjs/common';
import { BiometricModule } from '../ports/biometric/biometric.module';
import { DriversService } from './drivers.service';
import { DriversController } from './drivers.controller';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';

@Module({
  imports: [BiometricModule],
  providers: [DriversService, DriverSuspensionConsumer],
  controllers: [DriversController],
  exports: [DriversService],
})
export class DriversModule {}
