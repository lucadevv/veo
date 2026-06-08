/**
 * CoreModule (global) — singletons de infraestructura compartidos: Prisma (read/write),
 * el secreto de identidad interna y los guards de auth (InternalIdentity + RBAC).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_IDENTITY_SECRET, InternalIdentityGuard, RolesGuard } from '@veo/auth';
import { PrismaService } from './prisma.service';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

@Global()
@Module({
  providers: [PrismaService, internalSecretProvider, InternalIdentityGuard, RolesGuard],
  exports: [PrismaService, INTERNAL_IDENTITY_SECRET, InternalIdentityGuard, RolesGuard],
})
export class CoreModule {}
