/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, el secreto de identidad interna y los guards de auth.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_IDENTITY_SECRET,
  InternalIdentityGuard,
  RolesGuard,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  type InternalAudience,
} from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

// Rieles que pueden llamar los endpoints internos de places (lugares guardados del pasajero):
//  - public-rail: public-bff es el ÚNICO caller (gRPC PlacesService — ListByUser/Save/Update/Remove
//    del pasajero). No hay caller admin, driver ni service: los lugares son data del usuario final.
const ALLOWED_AUDIENCES: readonly InternalAudience[] = ['public-rail'];

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    InternalIdentityGuard,
    RolesGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    InternalIdentityGuard,
    RolesGuard,
  ],
})
export class CoreModule {}
