/**
 * FINANZAS — payouts y reembolsos (RBAC FINANCE/admin). payouts/run exige rol FINANCE.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
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
import type {
  PayoutView,
  PayoutDetailView,
  PayoutStatsView,
  PayoutTripsResult,
  RefundablePaymentView,
  RefundView,
  RefundDetailView,
  RefundStatsView,
  RefundActionResult,
  ReconciliationRunView,
} from '@veo/api-client';
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
  ExportPayoutsQueryDto,
  ReconciliationQueryDto,
  RunPayoutsDto,
  RefundDto,
  RefundsQueryDto,
  RejectRefundBodyDto,
  ReplaceOnDemandRateDto,
  ReplaceCarpoolingFeeDto,
  ReplaceCostPerKmDto,
} from './dto/finance.dto';
import { Permission } from '../policies/permission.decorator';

@ApiTags('finance')
@Controller('finance')
@Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('payouts')
  @Permission('finance:view')
  @ApiOperation({ summary: 'Listado paginado de payouts (filtro por estado)' })
  payouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PayoutsQueryDto,
  ): Promise<{ items: PayoutView[]; nextCursor: string | null }> {
    return this.finance.listPayouts(user, query);
  }

  // Ruta ESTÁTICA `payouts/stats` declarada ANTES de la paramétrica `payouts/:id` para que `:id` no capture
  // "stats". KPIs agregados (conteos + total): gate de clase FINANCE/ADMIN/SUPERADMIN, sin PII de persona.
  @Get('payouts/stats')
  @Permission('finance:view')
  @ApiOperation({ summary: 'KPIs de payouts: total liquidado + conteos por estado (stat cards)' })
  payoutStats(@CurrentUser() user: AuthenticatedUser): Promise<PayoutStatsView> {
    return this.finance.getPayoutStats(user);
  }

  // Export CSV del SET COMPLETO del filtro (server-side: exporta TODO el filtro, no la página cargada). Ruta
  // ESTÁTICA `payouts/export` ANTES de `payouts/:id` para que `:id` no capture "export". Devuelve text/csv con
  // headers de descarga; la acción se AUDITA en el service. `driverName` sale solo si el rol ve PII (Ley 29733).
  @Get('payouts/export')
  @Permission('finance:view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="payouts-export.csv"')
  @ApiOperation({ summary: 'Export CSV de payouts del filtro completo (sin paginar) — acceso auditado' })
  exportPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExportPayoutsQueryDto,
  ): Promise<string> {
    return this.finance.exportPayouts(user, query.status);
  }

  @Get('payouts/:id')
  @Permission('finance:view')
  @ApiOperation({
    summary: 'Detalle de un payout con breakdown (deuda CASH y credit-back neteados por FK)',
  })
  payoutDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutDetailView> {
    return this.finance.getPayoutDetail(user, id);
  }

  // "Viajes incluidos" del payout (reconstrucción por período que hace payment-service). Ruta `payouts/:id/trips`
  // (2 segmentos) no colisiona con `payouts/:id`. Agregado del propio conductor (sin PII de tercero) → finance:view.
  @Get('payouts/:id/trips')
  @Permission('finance:view')
  @ApiOperation({ summary: 'Viajes incluidos en un payout (reconstrucción por período)' })
  payoutTrips(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutTripsResult> {
    return this.finance.getPayoutTrips(user, id);
  }

  @Get('reconciliation')
  @Permission('finance:view')
  @ApiOperation({ summary: 'Historial de corridas de conciliación diaria (BR-P07) — FINANCE' })
  reconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ReconciliationQueryDto,
  ): Promise<{ items: ReconciliationRunView[]; nextCursor: string | null }> {
    return this.finance.getReconciliation(user, query);
  }

  @Post('payouts/run')
  @HttpCode(200)
  @Roles(AdminRole.FINANCE)
  @Permission('finance:payout')
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
  @Permission('finance:payout')
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
  @Permission('finance:payout')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Reintenta un payout FALLIDO (FAILED→PROCESSING, solo FINANCE)' })
  retryPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutDisburseResult> {
    return this.finance.retryPayout(user, id);
  }

  // ── Comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2 · CAS desacoplada #3). GET = finance:view (rol de
  // clase). PUT = finance:manage (FINANCE/ADMIN/SUPERADMIN) + step-up MFA. Las dos tasas se editan por SEPARADO,
  // cada una con SU CAS: comisión ON-DEMAND (descontada al conductor, CAS sobre `version`) y service fee CARPOOLING
  // (sumado al pasajero, CAS sobre `carpoolingFeeVersion` independiente) → editar una ya no 409ea la otra. El
  // escudo legal anti-lucro del carpooling es el cap costo/km, NO un fee=0. payment-service RE-valida RBAC +
  // step-up (defensa en profundidad) y audita el cambio. ──
  @Get('commission')
  @Permission('finance:view')
  @ApiOperation({
    summary:
      'Comisión por modo vigente (tasa ON-DEMAND + service fee CARPOOLING, ambas editables). finance:view',
  })
  getCommission(@CurrentUser() user: AuthenticatedUser): Promise<CommissionView> {
    return this.finance.getCommission(user);
  }

  @Put('commission/on-demand')
  @HttpCode(200)
  @Permission('finance:manage')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'Edita SOLO la comisión ON-DEMAND (bps, CAS sobre `version`). finance:manage + step-up',
  })
  replaceOnDemandRate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceOnDemandRateDto,
  ): Promise<CommissionView> {
    return this.finance.replaceOnDemandRate(user, dto);
  }

  @Put('commission/carpooling-fee')
  @HttpCode(200)
  @Permission('finance:manage')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'Edita SOLO el service fee CARPOOLING (bps, CAS sobre `carpoolingFeeVersion` independiente). finance:manage + step-up',
  })
  replaceCarpoolingFee(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceCarpoolingFeeDto,
  ): Promise<CommissionView> {
    return this.finance.replaceCarpoolingFee(user, dto);
  }

  // ── Costo/km del carpooling (F2.5 · escudo legal anti-lucro). GET = finance:view (rol de clase). PUT =
  // finance:manage + step-up MFA: cambia el costo/km de un país que alimenta DIRECTO el tope de cost-sharing.
  // booking-service RE-valida RBAC + step-up (defensa en profundidad) y aplica el CAS. ──
  @Get('cost-per-km')
  @Permission('finance:view')
  @ApiOperation({
    summary:
      'Costo de operación por km vigente por país (PE/EC). Alimenta el tope de cost-sharing. finance:view. F2.5',
  })
  getCostPerKm(@CurrentUser() user: AuthenticatedUser): Promise<CostPerKmListView> {
    return this.finance.getCostPerKm(user);
  }

  @Put('cost-per-km')
  @HttpCode(200)
  @Permission('finance:manage')
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

  @Get('payments/by-trip/:tripId')
  @Permission('finance:view')
  @ApiOperation({
    summary:
      'Cobro reembolsable de un viaje — inspección previa al reembolso (FINANCE; acceso a PII auditado, sin step-up por ser lectura)',
  })
  paymentByTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<RefundablePaymentView> {
    return this.finance.getPaymentByTrip(user, tripId);
  }

  // ── COLA DE APROBACIÓN DE REEMBOLSOS (money-OUT · frame HZ8uz) ──────────────────────────────────────
  // Rutas ESTÁTICAS/literales declaradas ANTES de las paramétricas para que `:id`/`:tripId` no las capturen.

  @Get('refunds')
  @Permission('finance:view')
  @ApiOperation({ summary: 'Cola de reembolsos (filtro por estado + cursor). Lista con PII → acceso auditado' })
  refunds(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RefundsQueryDto,
  ): Promise<{ items: RefundView[]; nextCursor: string | null }> {
    return this.finance.listRefunds(user, query);
  }

  // `refunds/stats` (literal) ANTES de `refunds/:id` para que `:id` no capture "stats".
  @Get('refunds/stats')
  @Permission('finance:view')
  @ApiOperation({ summary: 'KPIs de la cola de reembolsos (Solicitados/Aprobados/Procesado hoy/Tasa)' })
  refundStats(@CurrentUser() user: AuthenticatedUser): Promise<RefundStatsView> {
    return this.finance.getRefundStats(user);
  }

  @Get('refunds/:id')
  @Permission('finance:view')
  @ApiOperation({ summary: 'Detalle de un reembolso (con el saldo del cobro) — acceso a PII auditado' })
  refundDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RefundDetailView> {
    return this.finance.getRefund(user, id);
  }

  // APROBAR = desembolso money-OUT → finance:refund + step-up MFA (idéntico gate que la solicitud/el payout).
  @Post('refunds/:id/approve')
  @HttpCode(200)
  @Permission('finance:refund')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba y desembolsa un reembolso PENDING (idempotente). finance:refund + step-up' })
  approveRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RefundActionResult> {
    return this.finance.approveRefund(user, id);
  }

  @Post('refunds/:id/reject')
  @HttpCode(200)
  @Permission('finance:refund')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Rechaza un reembolso PENDING con motivo (idempotente). finance:refund + step-up' })
  rejectRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRefundBodyDto,
  ): Promise<RefundActionResult> {
    return this.finance.rejectRefund(user, id, dto.reason);
  }

  // SOLICITAR (crea la solicitud PENDING; NO desembolsa hasta aprobar). Ruta paramétrica `refunds/:tripId`
  // declarada DESPUÉS de las literales (`refunds`, `refunds/stats`) y de las de 2 segmentos (`:id/approve`).
  @Post('refunds/:tripId')
  @HttpCode(200)
  @Permission('finance:refund')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'SOLICITA un reembolso de un viaje: crea la solicitud PENDING (cola de aprobación), NO desembolsa hasta aprobar',
  })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') tripId: string,
    @Body() dto: RefundDto,
    // Idempotency-Key del panel → se PROPAGA a payment-service (no muere en el bff): barrera de idempotencia.
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<RefundActionResult> {
    return this.finance.refund(user, tripId, dto, idempotencyKey);
  }
}
