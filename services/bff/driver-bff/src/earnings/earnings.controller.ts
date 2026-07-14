/**
 * Ganancias del conductor. JWT de tipo 'driver'. Siempre filtradas al conductor autenticado.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type {
  DriverEarningsDailySeries,
  DriverEarningsSummary,
  DriverPayoutView,
  EarningsSummary,
} from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { EarningsService, type DriverCommissionRateView } from './earnings.service';

@ApiTags('earnings')
@DriverApi()
@Controller('earnings')
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Resumen de ganancias del conductor (agregado de sus payouts)' })
  summary(@CurrentUser() user: AuthenticatedUser): Promise<EarningsSummary> {
    return this.earnings.summary(user);
  }

  @Get('breakdown')
  @ApiOperation({
    summary:
      'Desglose de ganancias hoy/semana (bruto, comisión, propinas, neto, nº viajes) (BR-P05)',
  })
  breakdown(@CurrentUser() user: AuthenticatedUser): Promise<DriverEarningsSummary> {
    return this.earnings.breakdown(user);
  }

  @Get('daily')
  @ApiOperation({
    summary:
      'Serie diaria de ganancias de la semana en curso (lun→dom, 7 puntos) para el bar chart',
  })
  daily(@CurrentUser() user: AuthenticatedUser): Promise<DriverEarningsDailySeries> {
    return this.earnings.daily(user);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Lista de payouts (liquidaciones) del conductor autenticado' })
  payouts(@CurrentUser() user: AuthenticatedUser): Promise<DriverPayoutView[]> {
    return this.earnings.listPayouts(user);
  }

  @Get('commission-rate')
  @ApiOperation({
    summary:
      'Tasa de comisión ON-DEMAND VIGENTE (bps + version, panel admin). El app la usa en el desglose ' +
      'bruto − comisión; cacheada 60 s en el BFF',
  })
  commissionRate(@CurrentUser() user: AuthenticatedUser): Promise<DriverCommissionRateView> {
    return this.earnings.commissionRate(user);
  }
}
