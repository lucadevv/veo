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
import { PaymentsModule } from './payments/payments.module';
import { AffiliationsModule } from './affiliations/affiliations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PromotionsModule } from './promotions/promotions.module';
import { IncentivesModule } from './incentives/incentives.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EventsModule } from './events/events.module';
import { PaymentGrpcController } from './grpc/payment.grpc.controller';

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
    PaymentsModule,
    AffiliationsModule,
    WebhooksModule,
    PromotionsModule,
    IncentivesModule,
    PayoutsModule,
    ReconciliationModule,
    AnalyticsModule,
    EventsModule,
  ],
  controllers: [HealthController, MetricsController, PaymentGrpcController],
  providers: [readinessProvider],
})
export class AppModule {}
