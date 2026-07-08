/**
 * Endpoint INTERNO del historial de conciliación (BR-P07). Lo consume el admin-bff vía REST interno firmado
 * (REST_PAYMENT) para el panel FINANCE. El `ReconciliationRun` lo puebla el cron diario 04:00; acá se EXPONE
 * la LECTURA (antes no había forma de auditar las corridas desde el admin — hueco #3 del audit de seams).
 * Defensa en profundidad (mismo modelo que commission.controller):
 *  - InternalIdentityGuard + AudienceGuard (riel admin, fail-closed) → identidad interna válida.
 *  - RolesGuard + @Roles(FINANCE/ADMIN/SUPERADMIN) → RBAC server-side.
 * Es data AGREGADA del sistema (no PII de una persona) → lectura sin step-up ni audit.
 */
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
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
import { isHardenedEnv, NotFoundError } from '@veo/utils';
import {
  ReconciliationService,
  dayWindowUtc,
  previousDay,
  type ReconciliationResult,
  type ReconciliationRunPage,
} from './reconciliation.service';
import { ListReconciliationQueryDto, RunReconciliationDto } from './dto/reconciliation.dto';

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

  /**
   * ⚠️ TRIGGER DE DEV del cron de conciliación (BR-P07) — NO es una ruta de producto. El cron diario 04:00
   * (`ReconciliationService.dailyCron`) concilia el día previo; este endpoint permite dispararlo bajo demanda
   * para poblar la pantalla de Reconciliación en dev sin esperar al cron. NO cambia la lógica de `reconcile()`,
   * solo la EXPONE como disparador manual.
   *
   * GUARDAS (money-critical):
   *  - DEV-ONLY: `isHardenedEnv()` (NODE_ENV=production → preview/prod) ⇒ 404 (ruta inexistente en prod).
   *  - Auth interna: hereda los guards de clase (InternalIdentityGuard + AudienceGuard admin-rail + RolesGuard
   *    FINANCE/ADMIN/SUPERADMIN) — NO es público.
   *
   * Body: `date` opcional (YYYY-MM-DD, UTC) concilia ESE día; ausente ⇒ día previo (default del cron).
   */
  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'DEV-ONLY · Dispara la conciliación de un día (trigger manual del cron 04:00). 404 en producción',
  })
  runDev(@Body() body: RunReconciliationDto): Promise<ReconciliationResult> {
    // Dev-only: en entornos endurecidos (preview/prod) esta ruta NO existe → 404 (nunca un disparador de
    // conciliación manual expuesto en producción). El resto de guardas (auth interna + RBAC) las da la clase.
    if (isHardenedEnv()) {
      throw new NotFoundError('Cannot POST /reconciliation/run');
    }
    const { start, end } = body.date ? dayWindowUtc(body.date) : previousDay(new Date());
    return this.reconciliation.reconcile(start, end);
  }
}
