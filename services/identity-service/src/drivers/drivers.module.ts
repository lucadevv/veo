import { Module } from '@nestjs/common';
import { BiometricModule } from '../ports/biometric/biometric.module';
import { DriversService } from './drivers.service';
import { DriversController } from './drivers.controller';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';
import { HoldExpirySweeper } from './hold-expiry.sweeper';

@Module({
  imports: [BiometricModule],
  providers: [DriversService, DriverSuspensionConsumer, HoldExpirySweeper],
  controllers: [DriversController],
  exports: [DriversService],
})
export class DriversModule {}
