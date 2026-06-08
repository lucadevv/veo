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
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { PricingService, type ModeScheduleView } from './pricing.service';
import { ReplaceScheduleDto } from './dto/pricing.dto';

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
  @ApiOperation({ summary: 'REEMPLAZA wholesale el schedule de modo. pricing:manage (ADMIN/SUPERADMIN/FINANCE).' })
  replaceSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceScheduleDto,
  ): Promise<ModeScheduleView> {
    return this.pricing.replaceSchedule(user, dto);
  }
}
