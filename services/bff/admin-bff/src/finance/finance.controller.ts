/**
 * FINANZAS — payouts y reembolsos (RBAC FINANCE/admin). payouts/run exige rol FINANCE.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireStepUpMfa, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { PayoutView } from '@veo/api-client';
import {
  FinanceService,
  type CommissionView,
  type CostPerKmConfigView,
  type CostPerKmListView,
  type PayoutDisburseResult,
  type ReleaseHeldPayoutsResult,
  type RunPayoutsResult,
} from './finance.service';
import {
  PayoutsQueryDto,
  RunPayoutsDto,
  RefundDto,
  ReplaceCommissionDto,
  ReplaceCostPerKmDto,
} from './dto/finance.dto';

@ApiTags('finance')
@Controller('finance')
@Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('payouts')
  @ApiOperation({ summary: 'Listado paginado de payouts (filtro por estado)' })
  payouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PayoutsQueryDto,
  ): Promise<{ items: PayoutView[]; nextCursor: string | null }> {
    return this.finance.listPayouts(user, query);
  }

  @Post('payouts/run')
  @HttpCode(200)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Ejecuta el batch de payouts del periodo (solo FINANCE)' })
  runPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RunPayoutsDto,
  ): Promise<RunPayoutsResult> {
    return this.finance.runPayouts(user, dto);
  }

  // Camino de vuelta de driver.flagged: libera la plata retenida del conductor. Mutación de PLATA →
  // mismo rol restrictivo que payouts/run (solo FINANCE); el espejo de UI es `finance:payout` en rbac.ts.
  @Post('payouts/drivers/:driverId/release')
  @HttpCode(200)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Libera los payouts HELD de un conductor y levanta su retención (solo FINANCE)',
  })
  releaseDriverPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('driverId', ParseUUIDPipe) driverId: string,
  ): Promise<ReleaseHeldPayoutsResult> {
    return this.finance.releaseDriverPayouts(user, driverId);
  }

  // Reintento de un payout FALLIDO (ADR-015 §5): FAILED→PROCESSING re-invocando el riel, idempotente por
  // dedupKey. Mutación de PLATA → mismo rol restrictivo que payouts/run (solo FINANCE) + step-up MFA.
  @Post('payouts/:id/retry')
  @HttpCode(200)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Reintenta un payout FALLIDO (FAILED→PROCESSING, solo FINANCE)' })
  retryPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutDisburseResult> {
    return this.finance.retryPayout(user, id);
  }

  // ── Comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). GET = finance:view (rol de clase). PUT =
  // finance:manage (FINANCE/ADMIN/SUPERADMIN) + step-up MFA: cambia la tasa ON-DEMAND. El carpooling 0 NO se
  // toca (legal-gated). payment-service RE-valida RBAC + step-up (defensa en profundidad) y audita el cambio. ──
  @Get('commission')
  @ApiOperation({
    summary: 'Comisión por modo vigente (tasa ON-DEMAND configurable + carpooling 0 legal-gated). finance:view',
  })
  getCommission(@CurrentUser() user: AuthenticatedUser): Promise<CommissionView> {
    return this.finance.getCommission(user);
  }

  @Put('commission')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'REEMPLAZA la tasa de comisión ON-DEMAND (bps). El carpooling 0 no se toca. finance:manage + step-up',
  })
  replaceCommission(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceCommissionDto,
  ): Promise<CommissionView> {
    return this.finance.replaceCommission(user, dto);
  }

  // ── Costo/km del carpooling (F2.5 · escudo legal anti-lucro). GET = finance:view (rol de clase). PUT =
  // finance:manage + step-up MFA: cambia el costo/km de un país que alimenta DIRECTO el tope de cost-sharing.
  // booking-service RE-valida RBAC + step-up (defensa en profundidad) y aplica el CAS. ──
  @Get('cost-per-km')
  @ApiOperation({
    summary: 'Costo de operación por km vigente por país (PE/EC). Alimenta el tope de cost-sharing. finance:view. F2.5',
  })
  getCostPerKm(@CurrentUser() user: AuthenticatedUser): Promise<CostPerKmListView> {
    return this.finance.getCostPerKm(user);
  }

  @Put('cost-per-km')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'REEMPLAZA el costo/km de un país (céntimos PEN Int). finance:manage + step-up. F2.5',
  })
  replaceCostPerKm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceCostPerKmDto,
  ): Promise<CostPerKmConfigView> {
    return this.finance.replaceCostPerKm(user, dto);
  }

  @Post('refunds/:tripId')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Reembolsa el pago de un viaje' })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') tripId: string,
    @Body() dto: RefundDto,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    return this.finance.refund(user, tripId, dto);
  }
}
