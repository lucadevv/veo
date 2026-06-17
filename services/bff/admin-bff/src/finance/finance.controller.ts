/**
 * FINANZAS — payouts y reembolsos (RBAC FINANCE/admin). payouts/run exige rol FINANCE.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireStepUpMfa, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { PayoutView } from '@veo/api-client';
import {
  FinanceService,
  type ReleaseHeldPayoutsResult,
  type RunPayoutsResult,
} from './finance.service';
import { PayoutsQueryDto, RunPayoutsDto, RefundDto } from './dto/finance.dto';

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
