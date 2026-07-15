import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  EXPECTED_SUBJECT_TYPE,
  JwtAuthGuard,
  SessionRevocationGuard,
  type SubjectType,
} from '@veo/auth';
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
import { NotificationPrefsModule } from './notification-prefs/notification-prefs.module';
import { PromosModule } from './promos/promos.module';
import { ReferralsModule } from './referrals/referrals.module';
import { ChatModule } from './chat/chat.module';
import { SupportModule } from './support/support.module';
import { CarpoolModule } from './carpool/carpool.module';
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
    NotificationPrefsModule,
    PromosModule,
    ReferralsModule,
    ChatModule,
    SupportModule,
    CarpoolModule,
  ],
  providers: [
    // public-bff SOLO acepta tokens de tipo 'passenger' (el JwtAuthGuard rechaza conductor/admin
    // aunque la firma/audiencia sean válidas, mismo iss/aud/clave) — defensa en profundidad, igual
    // que admin-bff con 'admin' y driver-bff con 'driver'. No depende solo del RBAC.
    { provide: EXPECTED_SUBJECT_TYPE, useValue: 'passenger' satisfies SubjectType },
    // Orden de guards globales: Jwt (valida Bearer + puebla req.user) → SessionRevocation → RateLimit.
    // SessionRevocationGuard va JUSTO tras el Jwt (necesita req.user) y ANTES del RateLimit: un token
    // revocado (logout del pasajero, reuse detection del refresh) se rechaza sin consumir cuota. Lee el
    // denylist en Redis (enforcement server-side: el access token es stateless y su firma sigue válida
    // hasta 15m tras el revoke). Idempotente (solo lee) y fail-open ante Redis caído. Respeta @Public
    // vía la ausencia de req.user. Espeja driver-bff (Jwt → DriverType → SessionRevocation).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SessionRevocationGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
