/**
 * CoreModule (global) — singletons de infraestructura: Prisma (read/write), Redis y el secreto
 * de identidad interna + el InternalIdentityGuard (los BFFs propagan la identidad firmada HMAC).
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

// Rieles que pueden llamar los endpoints internos de chat (REST /chat — historial + mensajes del viaje):
//  - public-rail: el PASAJERO chatea con su conductor (public-bff, restProvider CHAT_URL).
//  - driver-rail: el CONDUCTOR chatea con su pasajero (driver-bff, rest.gateway route `chat` → CHAT_URL).
// El derecho al olvido (erasure) es event-driven (Kafka), no gateado por audiencia.
const ALLOWED_AUDIENCES: readonly InternalAudience[] = ['public-rail', 'driver-rail'];

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
