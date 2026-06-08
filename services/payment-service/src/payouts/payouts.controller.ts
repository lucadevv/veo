import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Roles,
  CurrentUser,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { assertDriverOwnsResource } from '@veo/auth';
import { ValidationError } from '@veo/utils';
import { PayoutsService, previousWeek } from './payouts.service';
import { RunPayoutsDto, ListPayoutsQueryDto } from './dto/payouts.dto';

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
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

  // ── Disparo manual (BR-P05): rol FINANCE. Step-up MFA si el total supera S/5000 (validado en el servicio). ──
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Correr la liquidación de payouts (FINANCE). >S/5000 requiere step-up MFA' })
  run(@Body() dto: RunPayoutsDto, @CurrentUser() user: AuthenticatedUser) {
    const fallback = previousWeek(new Date());
    const start = dto.periodStart ? new Date(dto.periodStart) : fallback.start;
    const end = dto.periodEnd ? new Date(dto.periodEnd) : fallback.end;
    return this.payouts.runPayouts(start, end, user);
  }
}
