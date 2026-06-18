/**
 * AuthController — endpoints de auth que proxean a identity y devuelven los tokens al caller.
 * admin-web persiste esos tokens en su cookie httpOnly (en su propio origen). El BFF trabaja con Bearer.
 */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, type AuthenticatedUser } from '@veo/auth';
import type { SessionUser, WsTicket } from '@veo/api-client';
import { SkipRateLimit } from '../rate-limit/skip-rate-limit.decorator';
import { WsTicketService } from '../gateway/ws-ticket.service';
import { AuthService, type AdminTokens, type LoginResult } from './auth.service';
import {
  LoginDto,
  TotpConfirmDto,
  StepUpDto,
  RefreshDto,
  LogoutDto,
  AcceptInviteDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly wsTickets: WsTicketService,
  ) {}

  @Public()
  @Post('invite/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aceptar invitación: el operador fija su contraseña → ACTIVE' })
  acceptInvite(@Body() dto: AcceptInviteDto): Promise<{ email: string }> {
    return this.auth.acceptInvite(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login email+password; puede devolver challenge de enrolamiento TOTP' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('totp/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirma el enrolamiento TOTP y devuelve los tokens admin' })
  totpConfirm(@Body() dto: TotpConfirmDto): Promise<AdminTokens> {
    return this.auth.totpConfirm(dto);
  }

  @Post('step-up')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step-up MFA (TOTP): re-emite un access con mfaAt fresco' })
  stepUp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StepUpDto,
  ): Promise<{ accessToken: string }> {
    return this.auth.stepUp(user, dto.totp);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotación de refresh token' })
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @SkipRateLimit()
  @ApiOperation({ summary: 'Cierra la sesión (revoca el refresh token)' })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.auth.logout(dto);
  }

  @Get('session')
  @ApiOperation({ summary: 'Valida el Bearer y devuelve el usuario de sesión' })
  session(@CurrentUser() user: AuthenticatedUser): SessionUser {
    return this.auth.session(user);
  }

  @Post('ws-ticket')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acuña un ticket efímero de un solo uso para el handshake WS /ops' })
  wsTicket(@CurrentUser() user: AuthenticatedUser): Promise<WsTicket> {
    return this.wsTickets.mint(user);
  }
}
