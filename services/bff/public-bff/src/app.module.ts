import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '@veo/auth';
import { MetricsModule } from '@veo/observability';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { HealthModule } from './common/health/health.module';
import { RateLimitGuard } from './ratelimit/rate-limit.guard';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TripsModule } from './trips/trips.module';
import { RatingsModule } from './ratings/ratings.module';
import { MapsModule } from './maps/maps.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { PaymentsModule } from './payments/payments.module';
import { PanicModule } from './panic/panic.module';
import { ShareModule } from './share/share.module';
import { ContactsModule } from './contacts/contacts.module';
import { PlacesModule } from './places/places.module';
import { KycModule } from './kyc/kyc.module';
import { DevicesModule } from './devices/devices.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PromosModule } from './promos/promos.module';
import { ReferralsModule } from './referrals/referrals.module';
import { ChatModule } from './chat/chat.module';
import { SupportModule } from './support/support.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    CoreModule,
    HealthModule,
    MetricsModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    TripsModule,
    RatingsModule,
    MapsModule,
    DispatchModule,
    PaymentsModule,
    PanicModule,
    ShareModule,
    ContactsModule,
    PlacesModule,
    KycModule,
    DevicesModule,
    NotificationsModule,
    PromosModule,
    ReferralsModule,
    ChatModule,
    SupportModule,
  ],
  providers: [
    // El JWT se valida primero (puebla req.user); luego el rate limiter usa la identidad.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
