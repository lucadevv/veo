import { Module } from '@nestjs/common';
import { PoliciesService } from './policies.service';
import { PoliciesRepository } from './policies.repository';
import { PoliciesSeeder } from './policies.seeder';
import { PoliciesController } from './policies.controller';

/**
 * Módulo PBAC (ADR-024, Fase 0): el STORAGE del registro de políticas de gobierno en identity-service.
 * PoliciesSeeder siembra el catálogo (OnModuleInit, idempotente); PoliciesRepository es el único dueño de Prisma
 * (FOUNDATION §10); PoliciesService orquesta el CRUD interno (validación + bump + outbox + audit).
 */
@Module({
  providers: [PoliciesService, PoliciesRepository, PoliciesSeeder],
  controllers: [PoliciesController],
  exports: [PoliciesService],
})
export class PoliciesModule {}
