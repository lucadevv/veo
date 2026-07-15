/**
 * Endpoint INTERNO del costo/km por país (F2.5). Lo consume el admin-bff vía REST interno firmado
 * (REST_BOOKING) — espeja `internal/finance/commission` de payment-service. Defensa en profundidad: aunque
 * el admin-bff ya gatea RBAC + step-up en su borde, este servicio NO confía en el caller:
 *  - InternalIdentityGuard + AudienceGuard (riel admin/finance, fail-closed) → identidad interna válida.
 *  - RolesGuard + @Roles(FINANCE/ADMIN/SUPERADMIN) → RBAC server-side (es config financiera).
 *  - @RequireStepUpMfa + StepUpMfaGuard en el PUT → mutación de config sensible (toca el escudo legal anti-lucro).
 *
 * El costo/km es el costo de OPERACIÓN real (combustible + desgaste) que alimenta DIRECTO el tope de
 * cost-sharing. El admin lo fija por país; NO se deriva del precio de energía.
 */
import { Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  InternalAudience,
  InternalIdentityGuard,
  RequireStepUpMfa,
  Roles,
  RolesGuard,
  StepUpMfaGuard,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { CostPerKmConfigService } from './cost-per-km-config.service';
import { ReplaceCostPerKmDto } from './dto/replace-cost-per-km.dto';
import type { PersistedCostPerKm } from './cost-per-km-config.repository';

/** Vista del GET: el costo/km vigente de cada país (PE + EC) + version. */
interface CostPerKmListView {
  configs: PersistedCostPerKm[];
}

@ApiTags('cost-per-km')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
@Controller('internal/finance')
export class CostPerKmController {
  constructor(private readonly costPerKm: CostPerKmConfigService) {}

  @Get('cost-per-km')
  @ApiOperation({
    summary:
      'Costo de operación por km vigente, por país (PE/EC). Alimenta DIRECTO el tope de cost-sharing. finance:view. F2.5',
  })
  async getCostPerKm(): Promise<CostPerKmListView> {
    return { configs: await this.costPerKm.listConfigs() };
  }

  @Put('cost-per-km')
  @HttpCode(200)
  @UseGuards(StepUpMfaGuard)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA el costo/km de un país (céntimos PEN Int). Autoaplica (CAS + cache). finance:manage + step-up MFA. F2.5',
  })
  async replaceCostPerKm(@Body() dto: ReplaceCostPerKmDto): Promise<PersistedCostPerKm> {
    return this.costPerKm.replace(dto.pais, dto.costPerKmCents, dto.expectedVersion);
  }
}
