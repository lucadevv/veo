import { Module } from '@nestjs/common';
import { BiometricModule } from '../ports/biometric/biometric.module';
import { DriversService } from './drivers.service';
import { DriversRepository } from './drivers.repository';
import { DriversController } from './drivers.controller';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';
import { TripLifecycleConsumer } from './trip-lifecycle.consumer';
import { HoldExpirySweeper } from './hold-expiry.sweeper';

@Module({
  imports: [BiometricModule],
  providers: [
    DriversService,
    DriversRepository,
    DriverSuspensionConsumer,
    TripLifecycleConsumer,
    HoldExpirySweeper,
  ],
  controllers: [DriversController],
  exports: [DriversService],
})
export class DriversModule {}
