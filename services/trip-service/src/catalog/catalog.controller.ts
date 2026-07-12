/**
 * Endpoints internos del overlay del catálogo (ADR 013 §1.2). Bajo `api/v1` → `/api/v1/internal/catalog`.
 * Protegidos por InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10):
 *  - GET   → catálogo efectivo (ofertas + enabled + version). Lectura: cualquier identidad interna firmada
 *            (public-bff lo consume para el quote/teaser; admin-bff para el panel).
 *  - PUT   → reemplazo wholesale del overlay + emite catalog.updated. MUTACIÓN con DEFENSA EN PROFUNDIDAD
 *            server-side (espeja payment-service · CommissionController; NO confía ciegamente en el caller):
 *            AdminIdentityGuard (type==='admin') + RolesGuard/@Roles (RBAC `catalog:manage`:
 *            FINANCE/ADMIN/SUPERADMIN, excluye SUPPORT/DISPATCHER) + StepUpMfaGuard/@RequireStepUpMfa
 *            (step-up MFA fresca). El RBAC fino se aplica ADEMÁS en admin-bff.
 */
import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  StepUpMfaGuard,
  Roles,
  RequireStepUpMfa,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { CatalogService } from './catalog.service';
import { AdminIdentityGuard } from '../pricing/admin-identity.guard';
import { CreateCustomOfferingDto, ReplaceCatalogDto } from './dto/catalog.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Catálogo efectivo (ofertas + enabled + version). ADR 013 §1.2' })
  getCatalog() {
    return this.catalog.getCatalog();
  }

  @Put()
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el overlay del catálogo (bump version) y emite catalog.updated. ' +
      'catalog:manage (FINANCE/ADMIN/SUPERADMIN) + step-up MFA (ADR 013).',
  })
  replaceCatalog(@Body() dto: ReplaceCatalogDto) {
    return this.catalog.replaceOverlay(dto.overrides, dto.expectedVersion);
  }

  @Post('offerings')
  @HttpCode(201)
  @UseGuards(AdminIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'ALTA de una oferta CUSTOM (id generado, mapea a un vehicleClass/serviceType existente). ' +
      'EXCLUSIVO SUPERADMIN + step-up MFA (acción sensible). ADR 013.',
  })
  createOffering(@Body() dto: CreateCustomOfferingDto) {
    return this.catalog.createCustomOffering({
      name: dto.name,
      vehicleClass: dto.vehicleClass,
      serviceType: dto.serviceType,
      mode: dto.mode,
      multiplier: dto.multiplier,
      minFareCents: dto.minFareCents,
      enabled: dto.enabled ?? true,
      createdBy: dto.createdBy,
    });
  }
}
