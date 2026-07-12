/**
 * CATALOG (ADR 013 · admin-bff) — CRUD proxy del overlay del catálogo de ofertas hacia trip-service.
 * RBAC (espejo de pricing: la disponibilidad de servicios es decisión comercial/operativa):
 *  - catalog:view   → leer el catálogo. Roles: ADMIN, SUPERADMIN, FINANCE (gate de clase).
 *  - catalog:manage → reemplazar el overlay (mutación). Roles: ADMIN, SUPERADMIN, FINANCE (gate del PUT).
 * El RolesGuard usa getAllAndOverride: el @Roles del método REEMPLAZA al de la clase → el PUT re-declara
 * su set. trip-service RE-valida: InternalIdentityGuard (firma) + AdminIdentityGuard (type==='admin').
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole, type ResolvedOffering } from '@veo/shared-types';
import {
  CatalogService,
  type CatalogView,
  type OfferingMetricsView,
} from './catalog.service';
import { CreateOfferingDto, ReplaceCatalogDto } from './dto/catalog.dto';
import { Permission } from '../policies/permission.decorator';

@ApiTags('catalog')
@Controller('catalog')
@Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Permission('catalog:view')
  @ApiOperation({
    summary: 'Catálogo efectivo (ofertas + enabled + version). catalog:view. ADR 013',
  })
  getCatalog(@CurrentUser() user: AuthenticatedUser): Promise<CatalogView> {
    return this.catalog.getCatalog(user);
  }

  @Get(':id/metrics')
  @Permission('catalog:view')
  @ApiOperation({
    summary:
      'Métricas 30d de UNA oferta (viajes completados + facturación bruta). catalog:view. Board HjDvx.',
  })
  getMetrics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<OfferingMetricsView> {
    return this.catalog.getMetrics(user, id);
  }

  @Put()
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
  @Permission('catalog:manage')
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'REEMPLAZA wholesale el overlay del catálogo (enabled por oferta). catalog:manage.',
  })
  replaceCatalog(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceCatalogDto,
  ): Promise<CatalogView> {
    return this.catalog.replaceCatalog(user, dto);
  }

  @Post('offerings')
  @HttpCode(201)
  // ALTA de una oferta CUSTOM = crear un producto nuevo → EXCLUSIVO SUPERADMIN (@Roles a nivel MÉTODO
  // REEMPLAZA los @Roles de la clase vía getAllAndOverride; SUPERADMIN ⊆ base de la clase, invariante OK) +
  // step-up MFA. trip-service RE-autoriza (@Roles(SUPERADMIN) + step-up). Más sensible que catalog:manage.
  @Roles(AdminRole.SUPERADMIN)
  @Permission('catalog:create')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'ALTA de una oferta CUSTOM (mapea a un vehicleClass/serviceType existente). catalog:create — SUPERADMIN + step-up MFA.',
  })
  createOffering(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOfferingDto,
  ): Promise<ResolvedOffering> {
    return this.catalog.createOffering(user, dto);
  }
}
