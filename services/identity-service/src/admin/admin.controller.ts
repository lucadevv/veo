import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Public,
  Roles,
  CurrentUser,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { AdminService, type AdminTokens } from './admin.service';
import { AdminRegisterDto, AdminLoginDto, AdminEnrollConfirmDto, ApproveAdminDto, StepUpDto } from './dto/admin.dto';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Auto-registro de operador (queda PENDING)' })
  register(@Body() dto: AdminRegisterDto): Promise<{ id: string; status: string }> {
    return this.admin.register(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login operador (email+password+TOTP); si no enroló, devuelve enrolamiento' })
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
  @UseGuards(InternalIdentityGuard)
  @Post('step-up')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step-up MFA (TOTP) para acciones sensibles (BR-S07)' })
  stepUp(@CurrentUser() user: AuthenticatedUser, @Body() dto: StepUpDto): Promise<{ accessToken: string }> {
    return this.admin.stepUp(user.userId, dto.totp);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('operators/pending')
  @ApiOperation({ summary: 'Listar operadores pendientes de aprobación' })
  listPending(): Promise<{ id: string; email: string; createdAt: Date }[]> {
    return this.admin.listPending();
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprobar operador y asignar roles' })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveAdminDto,
  ): Promise<{ id: string; status: string; roles: string[] }> {
    return this.admin.approve(id, dto.roles);
  }

  @ApiBearerAuth()
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post('operators/:id/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Rechazar operador' })
  async reject(@Param('id') id: string): Promise<void> {
    await this.admin.reject(id);
  }
}
