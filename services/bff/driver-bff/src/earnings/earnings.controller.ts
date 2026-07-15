/**
 * Ganancias del conductor. JWT de tipo 'driver'. Siempre filtradas al conductor autenticado.
 */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type {
  DriverEarningsDailySeries,
  DriverEarningsSummary,
  DriverPayoutView,
  EarningsSummary,
  PaymentView,
} from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { EarningsService, type DriverCommissionRateView } from './earnings.service';
import { SettleDebtDto } from './dto/settle-debt.dto';

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

  @Post('debt/settle')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'ADR-022 §P-A · Saldar la deuda de comisiones del conductor por un medio DIGITAL (la ÚNICA forma de ' +
      'desbloquearse tras cruzar el tope). Devuelve el checkout del Payment de liquidación. CASH → 400; ' +
      'sin deuda pendiente → 409',
  })
  settleDebt(
    @Body() dto: SettleDebtDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentView> {
    return this.earnings.settleDebt(user, dto);
  }
}
