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
import { MediaModule } from './media/media.module';
import { EventsModule } from './events/events.module';
import { MediaGrpcController } from './grpc/media.grpc.controller';

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
    // cacheado queda visible para el StepUpMfaGuard (auth.stepup) y RecordingService (media.retention). Su
    // Kafka reusa los brokers/clientId del servicio (groupId aislado `media-service-policy`); su REST interno
    // apunta a identity-service firmando admin-rail (lo exige GET /internal/policies).
    PolicyModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PolicyRuntimeConfig => ({
        serviceName: 'media-service',
        kafkaBrokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        identityBaseUrl: config.getOrThrow<string>('IDENTITY_INTERNAL_URL'),
        internalSecret: config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
      }),
    }),
    CoreModule,
    MediaModule,
    EventsModule,
  ],
  controllers: [HealthController, MetricsController, MediaGrpcController],
  providers: [readinessProvider],
})
export class AppModule {}
