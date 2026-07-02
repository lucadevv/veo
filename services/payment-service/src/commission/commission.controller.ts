/**
 * Endpoint INTERNO de comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). Lo consume el admin-bff vía
 * REST interno firmado (REST_PAYMENT) — espeja `internal/pricing/base-fare` de trip-service. Defensa en
 * profundidad: aunque el admin-bff ya gatea RBAC + step-up en su borde, este servicio NO confía en el caller:
 *  - InternalIdentityGuard + AudienceGuard (riel admin/finance, fail-closed) → identidad interna válida.
 *  - RolesGuard + @Roles(FINANCE/ADMIN/SUPERADMIN) → RBAC server-side (es config financiera).
 *  - @RequireStepUpMfa + StepUpMfaGuard en el PUT → mutación de config sensible.
 *
 * Se configuran AMBAS tasas (full-replace): la comisión ON-DEMAND (descontada al conductor) y el service fee
 * CARPOOLING (sumado al pasajero). Ambas admin-editables — el carpooling fee NO tiene nudo legal (es un cargo al
 * pasajero en cost-sharing, NO lucro sobre el conductor).
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
import { ReplaceCommissionDto, ReplacePspFeeDto } from './dto/commission.dto';
import type { PersistedCommission } from './commission.repository';

/** Vista del endpoint: ambas tasas configurables (on-demand + carpooling fee) en bps + version. */
type CommissionView = PersistedCommission;

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
      'Comisión por modo vigente: tasa ON-DEMAND + service fee CARPOOLING, ambas configurables (bps). finance:view. F2.7',
  })
  async getCommission(): Promise<CommissionView> {
    return this.commission.getConfig();
  }

  @Put('commission')
  @HttpCode(200)
  @UseGuards(StepUpMfaGuard)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA AMBAS tasas: comisión ON-DEMAND + service fee CARPOOLING (bps). finance:manage + step-up MFA. F2.7',
  })
  async replaceCommission(@Body() dto: ReplaceCommissionDto): Promise<CommissionView> {
    return this.commission.replace(dto.onDemandRateBps, dto.carpoolingFeeBps, dto.expectedVersion);
  }

  @Put('psp-fee')
  @HttpCode(200)
  @UseGuards(StepUpMfaGuard)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'P-B · EDITA el fee del PSP (ProntoPaga) por método (yape/plin/card/pagoefectivo, bps). El dueño carga la ' +
      'tarifa del convenio acá. finance:manage + step-up MFA. CAS por version.',
  })
  async replacePspFees(@Body() dto: ReplacePspFeeDto): Promise<CommissionView> {
    return this.commission.replacePspFees(
      {
        yapeFeeBps: dto.yapeFeeBps,
        plinFeeBps: dto.plinFeeBps,
        cardFeeBps: dto.cardFeeBps,
        pagoefectivoFeeBps: dto.pagoefectivoFeeBps,
      },
      dto.expectedVersion,
    );
  }
}
