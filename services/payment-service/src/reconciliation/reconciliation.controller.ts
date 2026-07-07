/**
 * Endpoint INTERNO del historial de conciliación (BR-P07). Lo consume el admin-bff vía REST interno firmado
 * (REST_PAYMENT) para el panel FINANCE. El `ReconciliationRun` lo puebla el cron diario 04:00; acá se EXPONE
 * la LECTURA (antes no había forma de auditar las corridas desde el admin — hueco #3 del audit de seams).
 * Defensa en profundidad (mismo modelo que commission.controller):
 *  - InternalIdentityGuard + AudienceGuard (riel admin, fail-closed) → identidad interna válida.
 *  - RolesGuard + @Roles(FINANCE/ADMIN/SUPERADMIN) → RBAC server-side.
 * Es data AGREGADA del sistema (no PII de una persona) → lectura sin step-up ni audit.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  InternalAudience,
  InternalIdentityGuard,
  Roles,
  RolesGuard,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { ReconciliationService, type ReconciliationRunPage } from './reconciliation.service';
import { ListReconciliationQueryDto } from './dto/reconciliation.dto';

@ApiTags('reconciliation')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Roles(AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN)
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @ApiOperation({
    summary: 'Historial paginado de corridas de conciliación (BR-P07) — FINANCE/ADMIN',
  })
  list(@Query() query: ListReconciliationQueryDto): Promise<ReconciliationRunPage> {
    return this.reconciliation.listRuns({ cursor: query.cursor, limit: query.limit });
  }
}
