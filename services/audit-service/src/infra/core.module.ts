/**
 * CoreModule (global) — singletons de infraestructura compartidos: Prisma (read/write),
 * el secreto de identidad interna y los guards de auth (InternalIdentity + RBAC).
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
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

// Rieles que pueden llamar los endpoints internos de audit:
//  - service-rail: CUALQUIER servicio interno registra una acción auditable (POST /audit + gRPC
//    AuditService.Record). Es la vía de ESCRITURA síncrona del resto del dominio.
//  - admin-rail: el back-office CONSULTA el WORM (admin-bff → GET /audit + GET /audit/verify,
//    RBAC COMPLIANCE_SUPERVISOR/SUPERADMIN).
// El grueso de la ingesta de eventos auditables es event-driven (Kafka consumer), no gateado por audiencia.
const ALLOWED_AUDIENCES: readonly InternalAudience[] = ['admin-rail', 'service-rail'];

@Global()
@Module({
  providers: [
    PrismaService,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    InternalIdentityGuard,
    RolesGuard,
  ],
  exports: [
    PrismaService,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    InternalIdentityGuard,
    RolesGuard,
  ],
})
export class CoreModule {}
