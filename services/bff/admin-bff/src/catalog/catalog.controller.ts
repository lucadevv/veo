/**
 * CATALOG (ADR 013 · admin-bff) — CRUD proxy del overlay del catálogo de ofertas hacia trip-service.
 * RBAC (espejo de pricing: la disponibilidad de servicios es decisión comercial/operativa):
 *  - catalog:view   → leer el catálogo. Roles: ADMIN, SUPERADMIN, FINANCE (gate de clase).
 *  - catalog:manage → reemplazar el overlay (mutación). Roles: ADMIN, SUPERADMIN, FINANCE (gate del PUT).
 * El RolesGuard usa getAllAndOverride: el @Roles del método REEMPLAZA al de la clase → el PUT re-declara
 * su set. trip-service RE-valida: InternalIdentityGuard (firma) + AdminIdentityGuard (type==='admin').
 */
import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { CatalogService, type CatalogView } from './catalog.service';
import { ReplaceCatalogDto } from './dto/catalog.dto';
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
}
