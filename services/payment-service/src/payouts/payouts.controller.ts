import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Roles,
  Audiences,
  CurrentUser,
  InternalIdentityGuard,
  AudienceGuard,
  RolesGuard,
  RequireStepUpMfa,
  StepUpMfaGuard,
  InternalAudience,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { assertDriverOwnsResource } from '@veo/auth';
import { ValidationError } from '@veo/utils';
import {
  PayoutsService,
  previousWeek,
  type PayoutPage,
  type PayoutDetail,
  type PayoutDisburseSummary,
  type ReleaseHeldPayoutsResult,
} from './payouts.service';
import { RunPayoutsDto, ListPayoutsQueryDto, ListAllPayoutsQueryDto } from './dto/payouts.dto';

// Riel del conductor/operador (NO service-rail · mínimo privilegio ADR-014 §5.5): declara explícito el set
// previo a F3a para que el AudienceGuard rechace fail-closed a un service-rail (la membresía global ahora
// admite service-rail solo por charge/debt/GetPayment).
const PASSENGER_RAILS = [
  InternalAudience.PUBLIC_RAIL,
  InternalAudience.DRIVER_RAIL,
  InternalAudience.ADMIN_RAIL,
] as const;

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(...PASSENGER_RAILS)
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar payouts (opcional por driverId)' })
  list(@Query() query: ListPayoutsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    if (!query.driverId) throw new ValidationError('driverId es requerido');
    // Anti-IDOR (defensa en profundidad): un conductor solo puede listar SUS payouts. El driverId
    // pedido debe coincidir con el driverId firmado en la identidad interna (resuelto por el BFF).
    // Identidades no-conductor (admin/finance vía admin-bff) pasan por su propio RBAC.
    assertDriverOwnsResource(user, query.driverId);
    return this.payouts.listByDriver(query.driverId);
  }

  // ── Listado admin de TODOS los payouts (paginado, por estado). RBAC finanzas/admin (no por-dueño). ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('all')
  @ApiOperation({
    summary: 'Listar todos los payouts (paginado, filtro por estado) — FINANCE/ADMIN',
  })
  listAll(@Query() query: ListAllPayoutsQueryDto): Promise<PayoutPage> {
    return this.payouts.listAll({ status: query.status, cursor: query.cursor, limit: query.limit });
  }

  // ── Detalle de UN payout con breakdown de auditoría (FINANCE/ADMIN). Segmento `:id` DESPUÉS de `all` (estático)
  // para que la paramétrica no capture "all". Lectura (sin step-up): el desglose es de los montos del conductor. ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get(':id')
  @ApiOperation({
    summary:
      'Detalle de un payout con breakdown (deuda CASH y credit-back neteados por FK) — FINANCE/ADMIN',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string): Promise<PayoutDetail> {
    return this.payouts.getPayout(id);
  }

  // ── Disparo manual (BR-P05): mutación de PLATA → finance:payout es EXCLUSIVO de FINANCE (VEO_SPEC_ADMIN
  // L98/L246: "ni ADMIN ni SUPERADMIN lo ven; el servidor los negaría"). El servidor es la última línea:
  // aunque el admin-bff ya restringe a FINANCE en su borde, este servicio NO confía en el caller y exige
  // FINANCE por sí mismo (defensa en profundidad, mínimo privilegio). Step-up MFA en DOS capas: el guard de
  // BORDE @RequireStepUpMfa rechaza ANTES de entrar al service (en entornos hardened); el service vuelve a
  // exigir step-up FRESCO cuando el total supera S/5000 (BR-S07) — el borde es por-acción, el service es
  // por-monto. Ninguna sustituye a la otra. ──
  @UseGuards(RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Disparar la liquidación del período (EXCLUSIVO FINANCE): agrega los PENDING faltantes y DESEMBOLSA (PENDING→PROCESSING+disburse). Step-up MFA; >S/5000 re-valida en el servicio',
  })
  async run(
    @Body() dto: RunPayoutsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ periodStart: string; periodEnd: string } & PayoutDisburseSummary> {
    const fallback = previousWeek(new Date());
    const start = dto.periodStart ? new Date(dto.periodStart) : fallback.start;
    const end = dto.periodEnd ? new Date(dto.periodEnd) : fallback.end;
    // ADR-015 §5 `POST /payouts/run`: el operador dispara la liquidación = AGREGAR (idempotente, crea los
    // PENDING que el cron aún no creó) + DESEMBOLSAR (PENDING→PROCESSING+disburse). El cron solo agrega; el
    // acto de mover plata es siempre humano + auditado + con step-up MFA. El MFA por-monto se valida en el
    // servicio sobre el total a desembolsar (BR-S07), no sobre el total agregado.
    await this.payouts.runPayouts(start, end, user);
    const summary = await this.payouts.disbursePendingForPeriod(start, end, user);
    return { periodStart: start.toISOString(), periodEnd: end.toISOString(), ...summary };
  }

  // ── Reintento de un payout FALLIDO (ADR-015 §5 `POST /payouts/:id/retry`): FAILED→PROCESSING, idempotente
  // por la MISMA dedupKey (el riel no duplica). Mutación de PLATA: EXCLUSIVO FINANCE + step-up MFA (borde +
  // re-validación por-monto en el servicio). ──
  @UseGuards(RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Reintentar un payout FALLIDO (FAILED→PROCESSING) — EXCLUSIVO FINANCE. Idempotente por dedupKey (el riel no duplica)',
  })
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PayoutDisburseSummary> {
    return this.payouts.retryPayout(id, user);
  }

  // ── Camino de VUELTA de driver.flagged (S4): el review del conductor se resolvió → liberar sus
  // payouts HELD (HELD→PROCESSED + payout.processed por outbox) y levantar la retención (srem).
  // Mutación de PLATA: EXCLUSIVO de FINANCE igual que /run (VEO_SPEC_ADMIN L102/L254 — ni ADMIN ni
  // SUPERADMIN). Step-up MFA en el borde (@RequireStepUpMfa) + re-validación por-monto >S/5000 en el
  // servicio (BR-S07). ──
  @UseGuards(RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE)
  @RequireStepUpMfa()
  @Post('drivers/:driverId/release')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Libera los payouts HELD de un conductor y levanta su retención (review resuelto) — EXCLUSIVO FINANCE. Idempotente',
  })
  release(
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReleaseHeldPayoutsResult> {
    return this.payouts.releaseHeldPayouts(driverId, user);
  }
}
