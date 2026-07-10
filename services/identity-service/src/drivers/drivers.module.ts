import { Module } from '@nestjs/common';
import { BiometricModule } from '../ports/biometric/biometric.module';
import { PoliciesModule } from '../policies/policies.module';
import { DriversService } from './drivers.service';
import { DriversRepository } from './drivers.repository';
import { DriversController } from './drivers.controller';
import { DriverSuspensionConsumer } from './driver-suspension.consumer';
import { TripLifecycleConsumer } from './trip-lifecycle.consumer';
import { HoldExpirySweeper } from './hold-expiry.sweeper';

@Module({
  // PoliciesModule exporta PoliciesService → el masking del DNI del conductor lee `pii.mask` (params.dniTail).
  imports: [BiometricModule, PoliciesModule],
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
