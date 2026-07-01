import { Controller, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard, Public } from '@veo/auth';
import { HealthController, MetricsController } from '@veo/observability';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { readinessProvider } from './common/readiness';
import { DriverTypeGuard } from './common/guards/driver-type.guard';
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
import { CarpoolModule } from './carpool/carpool.module';
import { MapsModule } from './maps/maps.module';

// Probes de orquestación / scraping de Prometheus: deben quedar ABIERTAS pese al JwtAuthGuard global.
// Se subclasean los controllers compartidos de @veo/observability SOLO para marcarlos @Public a nivel
// de clase (el guard lee IS_PUBLIC_KEY con getAllAndOverride sobre [handler, class]). Mismo patrón que
// public-bff (HealthController local @Public). No se altera el paquete compartido.
@Public()
@Controller('health')
class PublicHealthController extends HealthController {}

@Public()
@Controller('metrics')
class PublicMetricsController extends MetricsController {}

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
    CarpoolModule,
    MapsModule,
  ],
  controllers: [PublicHealthController, PublicMetricsController],
  providers: [
    readinessProvider,
    // FAIL-CLOSED por defecto (defensa en profundidad). Antes el driver-bff dependía de que cada
    // controller recordara @DriverApi(); el próximo que lo olvidara quedaba 100% abierto. Ahora el
    // default del BFF es cerrado a nivel global, espejando admin-bff/public-bff.
    //
    // Orden: JwtAuthGuard (valida Bearer + puebla req.user) → DriverTypeGuard (exige typ 'driver').
    // Ambos respetan @Public (IS_PUBLIC_KEY vía Reflector), así que las rutas públicas de auth
    // (otp/request, otp/verify, refresh, logout) y los probes (health/metrics) siguen abiertas.
    //
    // El RateLimitGuard NO se monta global a propósito: NO es idempotente (hace INCR en Redis), y como
    // @DriverApi() y AuthController ya lo aplican por-ruta, montarlo global duplicaría el conteo de la
    // ventana en cada ruta protegida. JwtAuthGuard y DriverTypeGuard sí son idempotentes, por lo que su
    // doble aplicación (global + @DriverApi redundante) es segura. @DriverApi() se conserva como refuerzo.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: DriverTypeGuard },
  ],
})
export class AppModule {}
