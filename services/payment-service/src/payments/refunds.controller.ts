import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { PaymentsService } from './payments.service';
import { RejectRefundDto } from './dto/payments.dto';

/**
 * REEMBOLSOS — cola de aprobación (money-OUT · frame HZ8uz). Controller DEDICADO (namespace `/refunds`) para no
 * colisionar con las rutas paramétricas de `/payments/:id`. SOLO lo consume el admin-bff (audiencia admin-rail,
 * mínimo privilegio; NO se abre a service-rail ni a los rieles de cliente). Defensa en profundidad: el admin-bff ya
 * gatea FINANCE + step-up en su borde, y aquí el servicio RE-valida por sí mismo — RolesGuard (clase FINANCE/ADMIN/
 * SUPERADMIN) en las lecturas, y RolesGuard + StepUpMfaGuard en las mutaciones que mueven/comprometen plata.
 */
@ApiTags('refunds')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Controller('refunds')
export class RefundsController {
  constructor(private readonly payments: PaymentsService) {}

  // Ruta ESTÁTICA `refunds/stats` declarada ANTES de la paramétrica `refunds/:id` (que `:id` no capture "stats").
  @Get('stats')
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'KPIs de la cola de reembolsos (Solicitados/Aprobados/Procesado hoy/Tasa)' })
  stats() {
    return this.payments.getRefundStats();
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Cola de reembolsos (filtro por estado + cursor). Incluye el cobro por FK' })
  list(@Query('status') status?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.payments.listRefundsForAdmin({
      status,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Detalle de un reembolso (con el saldo del cobro)' })
  detail(@Param('id') id: string) {
    return this.payments.getRefundForAdmin(id);
  }

  // ── APROBAR: PENDING → APPROVED + desembolso idempotente (reserva CAS + reverso al riel). Mutación money-OUT →
  // mismo rol restrictivo + step-up MFA que payouts/run y el refund. Monto alto (>umbral) exige ADMIN/SUPERADMIN
  // (dual-control, revalidado en el service). ──
  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba y DESEMBOLSA un reembolso PENDING (idempotente). FINANCE + step-up' })
  approve(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.approveRefund(id, user);
  }

  // ── RECHAZAR una solicitud PENDING (sin mover plata → sin compensación). Mismo gate que aprobar (mutación de la
  // cola money-OUT): FINANCE + step-up. El motivo se persiste en failureReason. ──
  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Rechaza un reembolso PENDING con motivo (idempotente). FINANCE + step-up' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectRefundDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.rejectRefund(id, user, dto.reason);
  }
}
