import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import type Redis from 'ioredis';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { REDIS } from './infra/redis';
import { HotIndexModule } from './hot-index/hot-index.module';
import { MapsModule } from './ports/maps/maps.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { HeatmapModule } from './heatmap/heatmap.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MessagingModule } from './messaging/messaging.module';
import { DispatchGrpcController } from './grpc/dispatch.grpc.controller';

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
    CoreModule,
    HotIndexModule,
    MapsModule,
    DispatchModule,
    HeatmapModule,
    AnalyticsModule,
    MessagingModule,
  ],
  controllers: [HealthController, MetricsController, DispatchGrpcController],
  providers: [readinessProvider],
})
export class AppModule {}
