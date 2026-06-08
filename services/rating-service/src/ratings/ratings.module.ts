import { Module } from '@nestjs/common';
import { RatingsService } from './ratings.service';
import { RatingsController } from './ratings.controller';
import { RatingRecomputeCron } from './rating-recompute.cron';
import { TripCompletedConsumer } from './trip-completed.consumer';

@Module({
  providers: [RatingsService, RatingRecomputeCron, TripCompletedConsumer],
  controllers: [RatingsController],
  exports: [RatingsService],
})
export class RatingsModule {}
