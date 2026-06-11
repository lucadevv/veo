/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, secreto de identidad interna, guards de @veo/auth y el relay del outbox.
 *
 * media-service no firma JWT (es un servicio downstream): solo verifica la identidad interna que
 * el BFF propaga (HMAC) y aplica RBAC + step-up MFA sobre el video (BR-S02/S07).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_IDENTITY_SECRET,
  InternalIdentityGuard,
  RolesGuard,
  StepUpMfaGuard,
} from '@veo/auth';
import { PrismaService } from './prisma.service';
import { redisProvider, REDIS } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    outboxRelayProvider,
    InternalIdentityGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    INTERNAL_IDENTITY_SECRET,
    InternalIdentityGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
})
export class CoreModule {}
