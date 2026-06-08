import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController, MetricsController } from '@veo/observability';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { readinessProvider } from './common/readiness';
import { AuthModule } from './auth/auth.module';
import { DriversModule } from './drivers/drivers.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { TripsModule } from './trips/trips.module';
import { PaymentsModule } from './payments/payments.module';
import { EarningsModule } from './earnings/earnings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MediaModule } from './media/media.module';
import { ChatModule } from './chat/chat.module';
import { HeatmapModule } from './heatmap/heatmap.module';
import { IncentivesModule } from './incentives/incentives.module';
import { SupportModule } from './support/support.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    CoreModule,
    AuthModule,
    DriversModule,
    DispatchModule,
    TripsModule,
    PaymentsModule,
    EarningsModule,
    NotificationsModule,
    MediaModule,
    ChatModule,
    HeatmapModule,
    IncentivesModule,
    SupportModule,
    RealtimeModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [readinessProvider],
})
export class AppModule {}
