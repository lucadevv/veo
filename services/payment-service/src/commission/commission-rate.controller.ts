/**
 * Endpoint INTERNO de LECTURA de la tasa de comisión ON-DEMAND para el RIEL DEL CONDUCTOR. Lo consume el
 * driver-bff (GET /earnings/commission-rate) para que la app muestre la tasa VIGENTE del panel admin en el
 * desglose de ganancias (TripComplete/TripDetail) — antes el app hardcodeaba 12% y mentía sea cual sea la
 * tasa configurada.
 *
 * SEPARADO de `CommissionController` a propósito (mínimo privilegio): aquel monta RolesGuard + ADMIN_RAIL +
 * roles FINANCE (un conductor no tiene roles admin → 403 estructural). Este controller expone SOLO la vista
 * mínima que es dato del conductor (la tasa que se le descuenta + version): NADA de carpooling fee, PSP fees
 * ni updatedAt. Riel DRIVER_RAIL exclusivo, fail-closed por AudienceGuard.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audiences, AudienceGuard, InternalAudience, InternalIdentityGuard } from '@veo/auth';
import { CommissionService } from './commission.service';

/** Vista MÍNIMA para el conductor: la tasa on-demand vigente (bps Int) + version del CAS del panel. */
export interface OnDemandRateView {
  onDemandRateBps: number;
  version: number;
}

@ApiTags('commission')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.DRIVER_RAIL)
@Controller('internal/finance/commission')
export class CommissionRateController {
  constructor(private readonly commission: CommissionService) {}

  @Get('on-demand-rate')
  @ApiOperation({
    summary:
      'Tasa de comisión ON-DEMAND vigente (bps) + version — vista mínima para el riel del conductor. ' +
      'La consume el driver-bff para el desglose de ganancias del app.',
  })
  async getOnDemandRate(): Promise<OnDemandRateView> {
    // getConfig ya cachea server-side (COMMISSION_CACHE_TTL_MS) y degrada honesto al env si la DB no está.
    const config = await this.commission.getConfig();
    return { onDemandRateBps: config.onDemandRateBps, version: config.version };
  }
}
