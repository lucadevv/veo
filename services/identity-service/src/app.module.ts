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
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { UsersModule } from './users/users.module';
import { DriversModule } from './drivers/drivers.module';
import { KycModule } from './kyc/kyc.module';
import { ConsentsModule } from './consents/consents.module';
import { ReferralsModule } from './referrals/referrals.module';
import { IdentityGrpcController } from './grpc/identity.grpc.controller';

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
    AuthModule,
    AdminModule,
    UsersModule,
    DriversModule,
    KycModule,
    ConsentsModule,
    ReferralsModule,
  ],
  controllers: [HealthController, MetricsController, IdentityGrpcController],
  providers: [readinessProvider],
})
export class AppModule {}
