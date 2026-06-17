/**
 * PRICING (ADR 011 §6 · M3) — CRUD proxy del schedule de modo PUJA↔FIJO hacia trip-service.
 * RBAC ratificado (§8.4):
 *  - pricing:view  → leer el schedule. Roles: ADMIN, SUPERADMIN, FINANCE (gate a nivel de clase).
 *  - pricing:manage→ reemplazar el schedule (mutación). Roles: ADMIN, SUPERADMIN, FINANCE (gate del PUT).
 * El RolesGuard usa getAllAndOverride: el @Roles del método REEMPLAZA al de la clase (no une). Por eso el
 * PUT declara explícitamente su propio set. El pricing es decisión financiera/comercial → no SUPPORT/DISPATCHER.
 * trip-service RE-valida: InternalIdentityGuard (firma) + AdminIdentityGuard (type==='admin') en el PUT.
 */
import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import {
  PricingService,
  type ModeScheduleView,
  type FuelSurchargeView,
  type EnergyCatalogView,
  type BidFloorView,
} from './pricing.service';
import { ReplaceScheduleDto, ReplaceFuelSurchargeDto, ReplaceBidFloorDto } from './dto/pricing.dto';
import { ReplaceEnergyCatalogDto } from './dto/energy-catalog.dto';

@ApiTags('pricing')
@Controller('pricing')
@Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('mode-schedule')
  @ApiOperation({ summary: 'Schedule de modo de pricing vigente (o el default PUJA). pricing:view. ADR 011' })
  getSchedule(@CurrentUser() user: AuthenticatedUser): Promise<ModeScheduleView> {
    return this.pricing.getSchedule(user);
  }

  @Put('mode-schedule')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'REEMPLAZA wholesale el schedule de modo. pricing:manage (ADMIN/SUPERADMIN/FINANCE).' })
  replaceSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceScheduleDto,
  ): Promise<ModeScheduleView> {
    return this.pricing.replaceSchedule(user, dto);
  }

  @Get('fuel-surcharge')
  @ApiOperation({ summary: 'Recargo de combustible por km vigente (o 0). pricing:view. B3' })
  getFuelSurcharge(@CurrentUser() user: AuthenticatedUser): Promise<FuelSurchargeView> {
    return this.pricing.getFuelSurcharge(user);
  }

  @Put('fuel-surcharge')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'REEMPLAZA el recargo de combustible por km. pricing:manage (ADMIN/SUPERADMIN/FINANCE).' })
  replaceFuelSurcharge(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceFuelSurchargeDto,
  ): Promise<FuelSurchargeView> {
    return this.pricing.replaceFuelSurcharge(user, dto);
  }

  @Get('energy-catalog')
  @ApiOperation({ summary: 'Catálogo de precios de energía por fuente vigente. pricing:view. B5' })
  getEnergyCatalog(@CurrentUser() user: AuthenticatedUser): Promise<EnergyCatalogView> {
    return this.pricing.getEnergyCatalog(user);
  }

  @Put('energy-catalog')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'REEMPLAZA wholesale los precios de energía. pricing:manage (ADMIN/SUPERADMIN/FINANCE). B5' })
  replaceEnergyCatalog(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceEnergyCatalogDto,
  ): Promise<EnergyCatalogView> {
    return this.pricing.replaceEnergyCatalog(user, dto);
  }

  @Get('bid-floor')
  @ApiOperation({ summary: 'Piso de la PUJA vigente (default + overrides por oferta, o el default S/7). pricing:view. ADR 010 §9.3' })
  getBidFloor(@CurrentUser() user: AuthenticatedUser): Promise<BidFloorView> {
    return this.pricing.getBidFloor(user);
  }

  @Put('bid-floor')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'REEMPLAZA el piso de la PUJA (default + overrides por oferta). pricing:manage (ADMIN/SUPERADMIN/FINANCE). ADR 010 §9.3' })
  replaceBidFloor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceBidFloorDto,
  ): Promise<BidFloorView> {
    return this.pricing.replaceBidFloor(user, dto);
  }
}
