/**
 * AuditController — lectura de la bitácora inmutable.
 * RBAC: COMPLIANCE_SUPERVISOR + SUPERADMIN únicamente (separación de funciones · decisión del
 * dueño): un ADMIN genérico NO lee el audit — quien opera no audita. Espeja el audit-service.
 */
import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { AuditEntryView } from '@veo/api-client';
import { Permission } from '../policies/permission.decorator';
import { AuditService, type VerifyResponse } from './audit.service';
import { AuditExportQueryDto, AuditQueryDto, AuditVerifyDto } from './dto/audit-query.dto';

@ApiTags('audit')
@Controller('audit')
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Permission('audit:view')
  @ApiOperation({ summary: 'Listado de auditoría (cursor beforeSeq)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditQueryDto,
  ): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
    return this.audit.list(user, query);
  }

  // Export CSV del SET COMPLETO del filtro (server-side). Ruta LITERAL `export` (no colisiona con paramétricas).
  // MISMO gate que el listado (audit:view · Roles COMPLIANCE_SUPERVISOR/SUPERADMIN a nivel de clase). El acceso se
  // AUDITA en el service (accountability · Ley 29733). Devuelve text/csv con headers de descarga.
  @Get('export')
  @Permission('audit:view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="auditoria-export.csv"')
  @ApiOperation({ summary: 'Export CSV del registro de auditoría del filtro vigente — acceso auditado' })
  exportAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditExportQueryDto,
  ): Promise<string> {
    return this.audit.exportAudit(user, {
      category: query.category,
      q: query.q,
      from: query.from,
      to: query.to,
    });
  }

  @Get('verify')
  @Permission('audit:verify')
  @ApiOperation({ summary: 'Verifica la integridad de la hash-chain' })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditVerifyDto,
  ): Promise<VerifyResponse> {
    return this.audit.verify(user, query);
  }
}
