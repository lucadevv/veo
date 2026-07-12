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
import { EngineModule } from './engine/engine.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationPrefsModule } from './notification-prefs/notification-prefs.module';
import { DevicesModule } from './devices/devices.module';
import { SupportModule } from './support/support.module';
import { ConsumersModule } from './consumers/consumers.module';

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
    EngineModule,
    NotificationsModule,
    NotificationPrefsModule,
    DevicesModule,
    SupportModule,
    ConsumersModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [readinessProvider],
})
export class AppModule {}
