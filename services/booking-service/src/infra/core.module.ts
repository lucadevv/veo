/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos del
 * booking-service: Prisma (read/write), Redis, CLOCK, el secreto de identidad interna + el set de
 * audiencias de riel permitidas, los guards de acceso server-side, y el relay del outbox.
 *
 * A diferencia de identity-service, el booking-service NO emite ni rota JWT (no es un IdP): es un
 * servicio downstream que CONFÍA en la identidad firmada que el BFF propaga (InternalIdentityGuard valida
 * el HMAC + el riel `aud`). Por eso acá NO viven JwtService ni el refresh store — solo lo necesario para
 * el acceso por riel (ADR-014 §8).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK, SystemClock } from '@veo/utils';
import {
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  INTERNAL_AUDIENCES,
  InternalIdentityGuard,
  AudienceGuard,
  RolesGuard,
  StepUpMfaGuard,
  type InternalAudience,
} from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { KAFKA_HEALTH, kafkaHealthProvider } from './kafka-health';
import { outboxRelayProvider } from './outbox.relay';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

/**
 * Base de MEMBRESÍA del HMAC para `InternalIdentityGuard`: la lista de rieles CONOCIDOS contra la que el
 * guard valida que el `aud` firmado sea uno válido del set cerrado. La AUTORIZACIÓN por-endpoint la hace
 * `@Audiences(...)` + `AudienceGuard` (fail-closed, por handler). Fuente única `INTERNAL_AUDIENCES`
 * (constante tipada), nunca literales sueltos — espeja identity-service.
 */
const ALLOWED_AUDIENCES: readonly InternalAudience[] = INTERNAL_AUDIENCES;

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    kafkaHealthProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    outboxRelayProvider,
    { provide: CLOCK, useValue: new SystemClock() },
    InternalIdentityGuard,
    AudienceGuard,
    // RBAC + step-up MFA del endpoint interno de config financiera (cost/km · F2.5). RolesGuard depende solo
    // del Reflector; StepUpMfaGuard del Reflector + CLOCK (provisto acá). Defensa en profundidad: booking
    // re-autoriza aunque el admin-bff ya gatee en su borde.
    RolesGuard,
    StepUpMfaGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    KAFKA_HEALTH,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    CLOCK,
    InternalIdentityGuard,
    AudienceGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
})
export class CoreModule {}
