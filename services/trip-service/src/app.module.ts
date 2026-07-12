import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import { PolicyModule, type PolicyRuntimeConfig } from '@veo/policy/nest';
import type Redis from 'ioredis';
import { validateEnv, type Env } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { REDIS } from './infra/redis';
import { TripsModule } from './trips/trips.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DriverTripsModule } from './drivers/driver-trips.module';
import { TripGrpcController } from './grpc/trip.grpc.controller';
import { TRIP_GRPC_REPO, PrismaTripGrpcRepository } from './grpc/trip-grpc.repository';

const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [PrismaService, REDIS],
  useFactory: (prisma: PrismaService, redis: Redis): ReadinessCheck[] => [
    {
      name: 'postgres',
      check: async () => {
        await prisma.read.$queryRaw`SELECT 1`;
        return true;
      },
    },
    {
      name: 'redis',
      check: async () => (await redis.ping()) === 'PONG',
    },
  ],
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    // Cliente runtime de políticas PBAC (ADR-024 Fase 1). GLOBAL (una carga + un consumer Kafka) → el reader
    // cacheado queda visible para el StepUpMfaGuard (`auth.stepup` en pricing/catalog admin): la ventana que
    // fija el superadmin surte efecto sin redeploy. Kafka reusa los brokers del servicio (groupId aislado
    // `trip-service-policy`); su REST interno apunta a identity-service firmando admin-rail. FAIL-SAFE:
    // identity/Kafka caídos NO tumban el boot — se sirven los DEFAULTS del catálogo.
    PolicyModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PolicyRuntimeConfig => ({
        serviceName: 'trip-service',
        kafkaBrokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        identityBaseUrl: config.getOrThrow<string>('IDENTITY_INTERNAL_URL'),
        internalSecret: config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
      }),
    }),
    CoreModule,
    TripsModule,
    AnalyticsModule,
    DriverTripsModule,
  ],
  controllers: [HealthController, MetricsController, TripGrpcController],
  // §10: TRIP_GRPC_REPO es el dueño del acceso Prisma del TripGrpcController (lector cross-servicio).
  providers: [
    readinessProvider,
    { provide: TRIP_GRPC_REPO, useClass: PrismaTripGrpcRepository },
  ],
})
export class AppModule {}
