import { Module } from '@nestjs/common';
import { MapsModule } from '../ports/maps/maps.module';
import { PricingModule } from '../pricing/pricing.module';
import { TripsService } from './trips.service';
import { TripQueryService } from './trip-query.service';
import { ScheduledTripService } from './scheduled-trip.service';
import { TripWatchdogService } from './trip-watchdog.service';
import { WaypointProposalService } from './waypoint-proposal.service';
import { WaypointProposalScheduler } from './waypoint-proposal.scheduler';
import { DispatchModeRegistry } from './dispatch-mode/dispatch-mode.registry';
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
    ScheduledTripService,
    TripWatchdogService,
    DispatchModeRegistry,
    DispatchConsumer,
    PujaConsumer,
    UserDeletedConsumer,
    ScheduledTripsScheduler,
    TripWatchdogScheduler,
    WaypointProposalService,
    WaypointProposalScheduler,
  ],
  controllers: [TripsController],
  exports: [TripsService, TripQueryService, WaypointProposalService],
})
export class TripsModule {}
