/**
 * Endpoint INTERNO de LECTURA del balance pendiente del conductor para el RIEL DEL CONDUCTOR. Lo consume el
 * driver-bff (GET /earnings/summary) para el "Por liquidar" HONESTO del app: devengado digital del período
 * ABIERTO + deuda/crédito PENDING — antes el app solo veía las filas Payout ya agregadas (que nacen recién
 * con el cron del lunes) y mostraba S/0 toda la semana, con la deuda CASH invisible.
 *
 * SEPARADO de `PayoutsController` a propósito (mínimo privilegio, mismo criterio que
 * CommissionRateController): aquel mezcla lecturas por-dueño con mutaciones FINANCE; este expone SOLO la
 * vista mínima que es dato del conductor. Riel DRIVER_RAIL exclusivo, fail-closed por AudienceGuard, y
 * anti-IDOR por identidad firmada (assertDriverOwnsResource): un conductor solo lee SU balance.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  assertDriverOwnsResource,
  type AuthenticatedUser,
} from '@veo/auth';
import { PayoutsService, type DriverPendingBalanceView } from './payouts.service';
import { DriverBalanceQueryDto } from './dto/payouts.dto';

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.DRIVER_RAIL)
@Controller('internal/finance/driver-balance')
export class PayoutsDriverBalanceController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('pending')
  @ApiOperation({
    summary:
      'Balance pendiente del conductor: devengado digital del período abierto + deuda/crédito PENDING — ' +
      'vista mínima para el riel del conductor. La consume el driver-bff para el "Por liquidar" del app.',
  })
  getPendingBalance(
    @Query() query: DriverBalanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DriverPendingBalanceView> {
    // Anti-IDOR (defensa en profundidad): el driverId pedido debe coincidir con el firmado en la identidad
    // interna (resuelto por el BFF) — mismo gate que GET /payouts y GET /payments/earnings.
    assertDriverOwnsResource(user, query.driverId);
    return this.payouts.getDriverPendingBalance(query.driverId);
  }
}
