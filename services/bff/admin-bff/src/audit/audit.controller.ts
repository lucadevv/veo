/**
 * AuditController — lectura de la bitácora inmutable.
 * RBAC: COMPLIANCE_SUPERVISOR + SUPERADMIN únicamente (separación de funciones · decisión del
 * dueño): un ADMIN genérico NO lee el audit — quien opera no audita. Espeja el audit-service.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { AuditEntryView } from '@veo/api-client';
import { AuditService, type VerifyResponse } from './audit.service';
import { AuditQueryDto, AuditVerifyDto } from './dto/audit-query.dto';

@ApiTags('audit')
@Controller('audit')
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Listado de auditoría (cursor beforeSeq)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditQueryDto,
  ): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
    return this.audit.list(user, query);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Verifica la integridad de la hash-chain' })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditVerifyDto,
  ): Promise<VerifyResponse> {
    return this.audit.verify(user, query);
  }
}
