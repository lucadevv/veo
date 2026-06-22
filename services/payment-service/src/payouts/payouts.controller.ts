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

  // ── Disparo manual (BR-P05): rol FINANCE. Step-up MFA si el total supera S/5000 (validado en el servicio). ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Correr la liquidación de payouts (FINANCE). >S/5000 requiere step-up MFA',
  })
  run(@Body() dto: RunPayoutsDto, @CurrentUser() user: AuthenticatedUser) {
    const fallback = previousWeek(new Date());
    const start = dto.periodStart ? new Date(dto.periodStart) : fallback.start;
    const end = dto.periodEnd ? new Date(dto.periodEnd) : fallback.end;
    return this.payouts.runPayouts(start, end, user);
  }

  // ── Camino de VUELTA de driver.flagged (S4): el review del conductor se resolvió → liberar sus
  // payouts HELD (HELD→PROCESSED + payout.processed por outbox) y levantar la retención (srem).
  // Mutación de PLATA: mismos roles que /run; >S/5000 exige step-up MFA (validado en el servicio). ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('drivers/:driverId/release')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Libera los payouts HELD de un conductor y levanta su retención (review resuelto) — FINANCE/ADMIN. Idempotente',
  })
  release(
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReleaseHeldPayoutsResult> {
    return this.payouts.releaseHeldPayouts(driverId, user);
  }
}
