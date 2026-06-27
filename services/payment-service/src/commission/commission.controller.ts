/**
 * Endpoint INTERNO de comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). Lo consume el admin-bff vía
 * REST interno firmado (REST_PAYMENT) — espeja `internal/pricing/base-fare` de trip-service. Defensa en
 * profundidad: aunque el admin-bff ya gatea RBAC + step-up en su borde, este servicio NO confía en el caller:
 *  - InternalIdentityGuard + AudienceGuard (riel admin/finance, fail-closed) → identidad interna válida.
 *  - RolesGuard + @Roles(FINANCE/ADMIN/SUPERADMIN) → RBAC server-side (es config financiera).
 *  - @RequireStepUpMfa + StepUpMfaGuard en el PUT → mutación de config sensible.
 *
 * SOLO se configura la tasa ON-DEMAND. El carpooling es 0 FIJO de dominio (CARPOOLING_COMMISSION_BPS): NO hay
 * endpoint para subirlo — requiere un ADR + flag legal, jamás un PUT del admin (ADR-015 §11.2).
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
import { CommissionService } from './commission.service';
import { ReplaceCommissionDto } from './dto/commission.dto';
import { CARPOOLING_COMMISSION_BPS } from '../payments/payment.policy';
import type { PersistedCommission } from './commission.repository';

/** Vista del endpoint: la tasa ON-DEMAND configurable + el carpooling 0 (solo-lectura, legal-gated) + version. */
interface CommissionView extends PersistedCommission {
  /** Comisión del carpooling en bps: 0 FIJO (ADR-015 §11.2). Expuesta solo-lectura para que el panel la pinte. */
  carpoolingRateBps: number;
}

@ApiTags('commission')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
@Controller('internal/finance')
export class CommissionController {
  constructor(private readonly commission: CommissionService) {}

  @Get('commission')
  @ApiOperation({
    summary:
      'Comisión por modo vigente: tasa ON-DEMAND configurable (bps) + carpooling 0 (legal-gated). finance:view. F2.7',
  })
  async getCommission(): Promise<CommissionView> {
    const config = await this.commission.getConfig();
    return { ...config, carpoolingRateBps: CARPOOLING_COMMISSION_BPS };
  }

  @Put('commission')
  @HttpCode(200)
  @UseGuards(StepUpMfaGuard)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA la tasa de comisión ON-DEMAND (bps). El carpooling 0 NO se toca (legal-gated). finance:manage + step-up MFA. F2.7',
  })
  async replaceCommission(@Body() dto: ReplaceCommissionDto): Promise<CommissionView> {
    const config = await this.commission.replace(dto.onDemandRateBps, dto.expectedVersion);
    return { ...config, carpoolingRateBps: CARPOOLING_COMMISSION_BPS };
  }
}
