import { Module } from '@nestjs/common';
import { PoliciesService } from './policies.service';
import { PoliciesRepository } from './policies.repository';
import { PoliciesSeeder } from './policies.seeder';
import { PoliciesController } from './policies.controller';
import { PermissionOverridesService } from './permission-overrides.service';
import { PermissionOverridesRepository } from './permission-overrides.repository';
import { PermissionOverridesController } from './permission-overrides.controller';

/**
 * Módulo de GOBIERNO unificado (ADR-024 · ADR-025 §2): el STORAGE de las DOS capas editables del gobierno del
 * acceso en identity-service, en un solo bounded-context / un solo audit / un solo cliente de enforcement:
 *   • Políticas (PBAC · capa 3): PoliciesService/Repository/Seeder + PoliciesController.
 *   • Overlay de permisos (subtract-only · capa 2 · ADR-025): PermissionOverridesService/Repository + su controller.
 * Ambos comparten el molde: tabla versionada, único dueño de Prisma (FOUNDATION §10), CRUD interno que valida +
 * bumpea version + emite su evento por outbox EN LA MISMA tx (audit WORM + invalidación de cache de @veo/policy).
 * El overlay NO tiene seeder: arranca vacío (sin restricciones = base pura), a diferencia del catálogo de Políticas.
 */
@Module({
  providers: [
    PoliciesService,
    PoliciesRepository,
    PoliciesSeeder,
    PermissionOverridesService,
    PermissionOverridesRepository,
  ],
  controllers: [PoliciesController, PermissionOverridesController],
  exports: [PoliciesService, PermissionOverridesService],
})
export class PoliciesModule {}
