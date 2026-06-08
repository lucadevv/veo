import { Module } from '@nestjs/common';
import { MapsModule } from '../ports/maps/maps.module';
import { PricingModule } from '../pricing/pricing.module';
import { TripsService } from './trips.service';
import { TripQueryService } from './trip-query.service';
import { TripsController } from './trips.controller';
import { DispatchConsumer } from './dispatch.consumer';
import { PujaConsumer } from './puja.consumer';
import { UserDeletedConsumer } from './user-deleted.consumer';
import { ScheduledTripsScheduler } from './scheduled-trips.scheduler';
import { TripWatchdogScheduler } from './trip-watchdog.scheduler';

@Module({
  imports: [MapsModule, PricingModule],
  providers: [
    TripsService,
    TripQueryService,
    DispatchConsumer,
    PujaConsumer,
    UserDeletedConsumer,
    ScheduledTripsScheduler,
    TripWatchdogScheduler,
  ],
  controllers: [TripsController],
  exports: [TripsService, TripQueryService],
})
export class TripsModule {}
