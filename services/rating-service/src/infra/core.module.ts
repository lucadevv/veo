/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, secreto de identidad interna, guards (@veo/auth) y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalIdentityGuard,
  RolesGuard,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  InternalAudience,
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

// Rieles que pueden llamar los endpoints internos de rating (REST /ratings + gRPC GetAggregate):
//  - public-rail: el PASAJERO califica y lee SU rating del viaje (public-bff, POST/GET /ratings firmado).
//  - driver-rail: el CONDUCTOR lee su agregado (driver-bff, gRPC GetAggregate vía GET /drivers/me).
//  - admin-rail: el back-office consulta agregados de un sujeto (admin-bff, gRPC rating).
// La ENTRADA de calificaciones por sistema (trip.completed) es event-driven (Kafka), no gateada por audiencia.
const ALLOWED_AUDIENCES: readonly InternalAudience[] = [
  InternalAudience.PUBLIC_RAIL,
  InternalAudience.DRIVER_RAIL,
  InternalAudience.ADMIN_RAIL,
];

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    outboxRelayProvider,
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
