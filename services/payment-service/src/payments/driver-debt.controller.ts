/**
 * ADR-022 §P-A · Endpoint del RIEL DEL CONDUCTOR para SALDAR su deuda de comisiones de viajes en EFECTIVO — la
 * ÚNICA forma de desbloquearse tras cruzar el tope (`DRIVER_DEBT_CAP_CENTS`). Crea un cobro DIGITAL de liquidación
 * (kind=DEBT_SETTLEMENT) por el TOTAL PENDING vía ProntoPaga y devuelve el checkout (deepLink/QR/urlPay) igual que
 * un cobro normal. Al capturarse (webhook/poll), payment marca sus driver_debts PENDING→PAID y emite
 * `driver.debt_cleared` → identity quita el hold DEBT_BLOCKED → el conductor vuelve a poder operar.
 *
 * SEPARADO de PaymentsController (mínimo privilegio, mismo criterio que PayoutsDriverBalanceController /
 * CommissionRateController): expone SOLO la mutación mínima que es dato del conductor. Riel DRIVER_RAIL exclusivo,
 * fail-closed por AudienceGuard, y anti-IDOR por identidad firmada (assertDriverOwnsResource): un conductor solo
 * salda SU deuda. Idempotente por la dedupKey del Payment de liquidación (doble-tap → mismo checkout).
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
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
import { PaymentsService } from './payments.service';
import { SettleDriverDebtDto } from './dto/payments.dto';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.DRIVER_RAIL)
@Controller('internal/finance/driver-debt')
export class DriverDebtController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('settle')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Saldar la deuda de comisiones del conductor por el rail (método digital) — devuelve el checkout. ' +
      'Idempotente (mismo checkout si ya está en curso; re-cobra si el previo declinó). CASH→422; sin deuda→409',
  })
  settle(@Body() dto: SettleDriverDebtDto, @CurrentUser() user: AuthenticatedUser) {
    // Anti-IDOR (defensa en profundidad): el driverId pedido debe coincidir con el firmado en la identidad
    // interna (resuelto por el BFF) — mismo gate que GET /payments/earnings y GET /internal/finance/driver-balance.
    assertDriverOwnsResource(user, dto.driverId);
    return this.payments.settleDriverDebt({
      driverId: dto.driverId,
      method: dto.method,
      payerRef: dto.payerRef,
    });
  }
}
