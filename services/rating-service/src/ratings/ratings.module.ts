import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RatingsService } from './ratings.service';
import { RatingsRepository } from './ratings.repository';
import { RatingsController } from './ratings.controller';
import { RatingRecomputeCron } from './rating-recompute.cron';
import { TripCompletedConsumer } from './trip-completed.consumer';
import { TRIP_CLIENT } from '../trip/trip-client.port';
import { GrpcTripClient } from '../trip/grpc-trip-client';
import type { Env } from '../config/env.schema';

// Cliente gRPC a trip-service para el gate de validación del create (existe + COMPLETED + participante).
// Lee TRIP_GRPC_URL + INTERNAL_IDENTITY_SECRET del entorno (espejo del identityClientProvider de dispatch).
const tripClientProvider: Provider = {
  provide: TRIP_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcTripClient(
      config.getOrThrow<string>('TRIP_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

@Module({
  providers: [
    RatingsService,
    RatingsRepository,
    RatingRecomputeCron,
    TripCompletedConsumer,
    tripClientProvider,
  ],
  controllers: [RatingsController],
  exports: [RatingsService],
})
export class RatingsModule {}
