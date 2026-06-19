/**
 * CoreModule (global) — singletons de infraestructura compartidos: Prisma (read/write), Redis,
 * secreto de identidad interna + InternalIdentityGuard (propagación BFF→servicio) y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_IDENTITY_SECRET,
  InternalIdentityGuard,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  type InternalAudience,
} from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

// Rieles que pueden llamar los endpoints internos de notification:
//  - service-rail: OTROS servicios que ENCOLAN notificaciones (p.ej. identity manda el OTP de login
//    vía POST /notifications) — es el caller dominante de /notifications.
//  - driver-rail / public-rail: los BFFs que registran device-tokens y abren tickets de soporte
//    (conductor vía driver-bff, pasajero vía public-bff) + lectura de notificaciones.
// El resto del trabajo de notification es event-driven (Kafka), no gateado por audiencia.
const ALLOWED_AUDIENCES: readonly InternalAudience[] = ['service-rail', 'driver-rail', 'public-rail'];

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    InternalIdentityGuard,
    outboxRelayProvider,
  ],
  exports: [
    PrismaService,
    REDIS,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    InternalIdentityGuard,
  ],
})
export class CoreModule {}
