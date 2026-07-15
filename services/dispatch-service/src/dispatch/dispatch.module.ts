import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { DispatchController } from './dispatch.controller';
import { OfferBoardController } from './offer-board.controller';
import { DispatchService } from './dispatch.service';
import { MatchingService } from './matching.service';
import { DriverPool } from './driver-pool';
import { OperableVehicleClassesProvider } from './operable-vehicle-classes.provider';
import { MatchingSessionStore } from './matching-session.store';
import { NearbyDriversService } from './nearby-drivers.service';
import { SurgeService } from './surge.service';
import { DriverProjectionService } from './driver-projection.service';
import { DriverSuspensionService } from './driver-suspension.service';
import { scorerProvider } from './scorer.provider';
import { OFFER_DELIVERY } from './offer-delivery.port';
import { RealtimeOfferDelivery } from './realtime-offer-delivery';
import { EPHEMERAL_EVENT_PUBLISHER } from './ephemeral-event.port';
import { KafkaEphemeralPublisher } from './kafka-ephemeral-publisher';
import { OFFER_BOARD_STORE } from './offer-board.port';
import { RedisOfferBoardStore } from './redis-offer-board.store';
import { OfferBoardService } from './offer-board.service';
import { OfferBoardScheduler } from './offer-board.scheduler';
import { DispatchTimeoutReconciler } from './dispatch-timeout.reconciler';
import { EligibilityGate, ELIGIBILITY_CACHE_TTL_MS } from './eligibility.gate';
import { DispatchRadiusConfigController } from './dispatch-radius-config.controller';
import {
  DispatchRadiusConfigService,
  DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS,
  DISPATCH_WINDOW_DEFAULTS,
} from './dispatch-radius-config.service';
import { RadarPreviewService } from './radar-preview.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import {
  DISPATCH_RADIUS_CONFIG_REPO,
  PrismaDispatchRadiusConfigRepository,
} from './dispatch-radius-config.repository';
import { DISPATCH_REPO, PrismaDispatchRepository } from './dispatch.repository';
import { MATCHING_REPO, PrismaMatchingRepository } from './matching.repository';
import {
  MATCHING_SESSION_REPO,
  PrismaMatchingSessionRepository,
} from './matching-session.repository';
import {
  DRIVER_PROJECTION_REPO,
  PrismaDriverProjectionRepository,
} from './driver-projection.repository';
import { OFFER_BOARD_REPO, PrismaOfferBoardRepository } from './offer-board.repository';
import { SURGE_REPO, PrismaSurgeRepository } from './surge.repository';
import { IDENTITY_CLIENT } from '../identity/identity-client.port';
import { GrpcIdentityClient } from '../identity/grpc-identity-client';
import { FLEET_CLIENT } from '../fleet/fleet-client.port';
import { GrpcFleetClient } from '../fleet/grpc-fleet-client';
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
    new GrpcIdentityClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

const fleetClientProvider: Provider = {
  provide: FLEET_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcFleetClient(
      config.getOrThrow<string>('FLEET_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

// A4 — TTL (ms) del cache de elegibilidad, desde ELIGIBILITY_CACHE_TTL_MS (default 3s en el schema).
const eligibilityCacheTtlProvider: Provider = {
  provide: ELIGIBILITY_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('ELIGIBILITY_CACHE_TTL_MS'),
};

// TTL (ms) del cache de la config de radios, desde DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS (default 10s).
const radiusConfigCacheTtlProvider: Provider = {
  provide: DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS'),
};

// SEED (env → default de la DB) de las VENTANAS de dispatch: sin fila en dispatch_radius_config el service
// degrada a ESTOS valores del env (DISPATCH_OFFER_TIMEOUT_MS / BID_WINDOW_SEC). Es el rol "env = seed del
// default": la autoridad viva es la fila de la DB (editable por el admin), el env solo la SIEMBRA.
const dispatchWindowDefaultsProvider: Provider = {
  provide: DISPATCH_WINDOW_DEFAULTS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    offerTimeoutMs: config.getOrThrow<number>('DISPATCH_OFFER_TIMEOUT_MS'),
    bidWindowSec: config.getOrThrow<number>('BID_WINDOW_SEC'),
  }),
};

@Module({
  controllers: [DispatchController, OfferBoardController, DispatchRadiusConfigController],
  providers: [
    scorerProvider,
    { provide: EPHEMERAL_EVENT_PUBLISHER, useClass: KafkaEphemeralPublisher },
    { provide: OFFER_DELIVERY, useClass: RealtimeOfferDelivery },
    offerBoardStoreProvider,
    identityClientProvider,
    fleetClientProvider,
    eligibilityCacheTtlProvider,
    DriverProjectionService,
    DriverSuspensionService,
    SurgeService,
    // Filtro defensivo de clase operable del pool (seam catálogo↔operabilidad · ADR 013): DriverPool lo inyecta
    // OPCIONAL (@Optional). Lee `/internal/catalog` de trip vía TRIP_REST (CoreModule global), cache corto, degrada.
    OperableVehicleClassesProvider,
    DriverPool,
    MatchingSessionStore,
    MatchingService,
    NearbyDriversService,
    DispatchService,
    EligibilityGate,
    OfferBoardService,
    OfferBoardScheduler,
    DispatchTimeoutReconciler,
    // Config de RADIOS (k-rings) editable en runtime por el admin (espejo del pricing del trip-service).
    DispatchRadiusConfigService,
    // Radar-preview: densidad real de conductores por anillo para la política configurada (planning admin).
    RadarPreviewService,
    AdminIdentityGuard,
    radiusConfigCacheTtlProvider,
    dispatchWindowDefaultsProvider,
    // Puertos → adaptadores Prisma (FOUNDATION §10: cada feature accede a Prisma SOLO por su repository;
    // el servicio depende de la interfaz, no de la clase concreta).
    { provide: DISPATCH_RADIUS_CONFIG_REPO, useClass: PrismaDispatchRadiusConfigRepository },
    { provide: DISPATCH_REPO, useClass: PrismaDispatchRepository },
    { provide: MATCHING_REPO, useClass: PrismaMatchingRepository },
    { provide: MATCHING_SESSION_REPO, useClass: PrismaMatchingSessionRepository },
    { provide: DRIVER_PROJECTION_REPO, useClass: PrismaDriverProjectionRepository },
    { provide: OFFER_BOARD_REPO, useClass: PrismaOfferBoardRepository },
    { provide: SURGE_REPO, useClass: PrismaSurgeRepository },
  ],
  exports: [
    DispatchService,
    MatchingService,
    NearbyDriversService,
    SurgeService,
    DriverProjectionService,
    DriverSuspensionService,
    OfferBoardService,
    EligibilityGate,
    DispatchRadiusConfigService,
  ],
})
export class DispatchModule {}
