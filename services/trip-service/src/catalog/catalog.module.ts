/**
 * CatalogModule (ADR 013 §1.2) — overlay del catálogo de ofertas editable en caliente: el CatalogService,
 * su endpoint interno y el adaptador Prisma del singleton. Exporta CatalogService para que TripsService lo
 * consuma en createTrip (rechazar una oferta apagada) y para el GET/PUT interno. El TTL del cache usa el
 * default del servicio (10s) — sin env var nueva (YAGNI; el schedule sí lo tiene por su hot-path mayor).
 */
import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { AdminIdentityGuard } from '../pricing/admin-identity.guard';
import { OFFERING_CATALOG_REPO, PrismaOfferingCatalogRepository } from './catalog.repository';
import {
  CUSTOM_OFFERING_REPO,
  PrismaCustomOfferingRepository,
} from './custom-offering.repository';

@Module({
  controllers: [CatalogController],
  providers: [
    CatalogService,
    AdminIdentityGuard,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: OFFERING_CATALOG_REPO, useClass: PrismaOfferingCatalogRepository },
    // ADR 013 · tabla de ofertas CUSTOM (built-in ∪ custom en el catálogo efectivo).
    { provide: CUSTOM_OFFERING_REPO, useClass: PrismaCustomOfferingRepository },
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
