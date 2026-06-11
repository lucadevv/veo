import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { ChatModule } from './chat/chat.module';
import { EventsModule } from './events/events.module';

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
    CoreModule,
    ChatModule,
    EventsModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [readinessProvider],
})
export class AppModule {}
