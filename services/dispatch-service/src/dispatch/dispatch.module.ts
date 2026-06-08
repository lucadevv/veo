import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { DispatchController } from './dispatch.controller';
import { OfferBoardController } from './offer-board.controller';
import { DispatchService } from './dispatch.service';
import { MatchingService } from './matching.service';
import { DriverPool } from './driver-pool';
import { MatchingSessionStore } from './matching-session.store';
import { NearbyDriversService } from './nearby-drivers.service';
import { SurgeService } from './surge.service';
import { DriverProjectionService } from './driver-projection.service';
import { scorerProvider } from './scorer.provider';
import { OFFER_DELIVERY } from './offer-delivery.port';
import { RealtimeOfferDelivery } from './realtime-offer-delivery';
import { EPHEMERAL_EVENT_PUBLISHER } from './ephemeral-event.port';
import { KafkaEphemeralPublisher } from './kafka-ephemeral-publisher';
import { OFFER_BOARD_STORE } from './offer-board.port';
import { RedisOfferBoardStore } from './redis-offer-board.store';
import { OfferBoardService } from './offer-board.service';
import { OfferBoardScheduler } from './offer-board.scheduler';
import { EligibilityGate, ELIGIBILITY_CACHE_TTL_MS } from './eligibility.gate';
import { IDENTITY_CLIENT } from '../identity/identity-client.port';
import { GrpcIdentityClient } from '../identity/grpc-identity-client';
import type { Env } from '../config/env.schema';

const offerBoardStoreProvider: Provider = {
  provide: OFFER_BOARD_STORE,
  inject: [REDIS],
  useFactory: (redis: Redis) => new RedisOfferBoardStore(redis),
};

const identityClientProvider: Provider = {
  provide: IDENTITY_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcIdentityClient(config.getOrThrow<string>('IDENTITY_GRPC_URL')),
};

// A4 — TTL (ms) del cache de elegibilidad, desde ELIGIBILITY_CACHE_TTL_MS (default 3s en el schema).
const eligibilityCacheTtlProvider: Provider = {
  provide: ELIGIBILITY_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('ELIGIBILITY_CACHE_TTL_MS'),
};

@Module({
  controllers: [DispatchController, OfferBoardController],
  providers: [
    scorerProvider,
    { provide: EPHEMERAL_EVENT_PUBLISHER, useClass: KafkaEphemeralPublisher },
    { provide: OFFER_DELIVERY, useClass: RealtimeOfferDelivery },
    offerBoardStoreProvider,
    identityClientProvider,
    eligibilityCacheTtlProvider,
    DriverProjectionService,
    SurgeService,
    DriverPool,
    MatchingSessionStore,
    MatchingService,
    NearbyDriversService,
    DispatchService,
    EligibilityGate,
    OfferBoardService,
    OfferBoardScheduler,
  ],
  exports: [
    DispatchService,
    MatchingService,
    NearbyDriversService,
    SurgeService,
    DriverProjectionService,
    OfferBoardService,
    EligibilityGate,
  ],
})
export class DispatchModule {}
