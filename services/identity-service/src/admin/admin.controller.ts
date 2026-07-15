import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  Public,
  Roles,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import {
  AdminService,
  type AdminTokens,
  type OperatorSummary,
  type OperatorDetail,
} from './admin.service';
import {
  AdminLoginDto,
  AdminEnrollConfirmDto,
  AcceptInviteDto,
  CreateOperatorDto,
  ChangeOperatorRolesDto,
  StepUpDto,
} from './dto/admin.dto';

@ApiTags('admin')
@Audiences(InternalAudience.ADMIN_RAIL)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Public()
  @Post('invite/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aceptar invitación: el operador fija su contraseña → ACTIVE' })
  acceptInvite(@Body() dto: AcceptInviteDto): Promise<{ email: string }> {
    return this.admin.acceptInvite(dto.token, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login operador (email+password+TOTP); si no enroló, devuelve enrolamiento',
  })
  login(
    @Body() dto: AdminLoginDto,
  ): Promise<AdminTokens | { mustEnrollTotp: true; otpauthUrl: string }> {
    return this.admin.login(dto.email, dto.password, dto.totp);
  }

  @Public()
  @Post('totp/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar enrolamiento TOTP y emitir tokens' })
  confirmTotp(@Body() dto: AdminEnrollConfirmDto): Promise<AdminTokens> {
    return this.admin.confirmTotpEnrollment(dto.email, dto.password, dto.totp);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard)
  @Post('step-up')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step-up MFA (TOTP) para acciones sensibles (BR-S07)' })
  stepUp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StepUpDto,
  ): Promise<{ accessToken: string }> {
    return this.admin.stepUp(user.userId, dto.totp);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('operators')
  @ApiOperation({ summary: 'Listar todos los operadores (gestión de staff)' })
  listOperators(): Promise<OperatorSummary[]> {
    return this.admin.listOperators();
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators')
  @HttpCode(200)
  @ApiOperation({ summary: 'Crear operador (email+roles) → INVITED + link de invitación' })
  createOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOperatorDto,
  ): Promise<{ id: string; inviteToken: string; inviteUrl: string; expiresAt: Date }> {
    return this.admin.createOperator(user.roles, user.userId, dto.email, dto.roles);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('operators/:id')
  @ApiOperation({ summary: 'Detalle de un operador: core + 2FA + último acceso + sesiones activas' })
  operatorDetail(@Param('id') id: string): Promise<OperatorDetail> {
    return this.admin.getOperatorDetail(id);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/roles')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cambia los roles RBAC de un operador (anti-escalada + auditoría de privilegio)' })
  changeRoles(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeOperatorRolesDto,
  ): Promise<OperatorDetail> {
    return this.admin.changeRoles(user.roles, user.userId, id, dto.roles);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspende un operador (status → SUSPENDED · revoca sus sesiones)' })
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<OperatorDetail> {
    return this.admin.suspend(user.roles, user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/remove')
  @HttpCode(204)
  @ApiOperation({ summary: 'Elimina (soft-delete) un operador (deletedAt · fuera de la lista · revoca sesiones)' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.admin.remove(user.roles, user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/sessions/:sessionId/revoke')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoca UNA sesión activa de un operador (refresh-store + denylist por-sid)' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.admin.revokeSession(user.roles, user.userId, id, sessionId);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/reinvite')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-emitir la invitación de un operador aún no aceptada' })
  reinvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ inviteUrl: string; expiresAt: Date }> {
    return this.admin.reinvite(user.roles, user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, AudienceGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Rechazar operador' })
  async reject(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.admin.reject(user.roles, user.userId, id);
  }
}
