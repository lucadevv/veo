/**
 * AuthController — endpoints de auth que proxean a identity y devuelven los tokens al caller.
 * admin-web persiste esos tokens en su cookie httpOnly (en su propio origen). El BFF trabaja con Bearer.
 */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, type AuthenticatedUser } from '@veo/auth';
import type { SessionUser, WsTicket } from '@veo/api-client';
import { SkipRateLimit } from '../rate-limit/skip-rate-limit.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
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

/** Ventanas reutilizadas en los límites estrictos POR MÉTODO de auth (hardening L1, ADR-012). */
const MINUTE_MS = 60_000;
const TEN_MIN_MS = 10 * MINUTE_MS;
/** Anti-bruteforce login email+password: intentos por IP+email (identity ya tiene lockout propio). */
const LOGIN_MAX = 10;
/** Confirmación TOTP (enrolamiento): intentos por IP+email. */
const TOTP_CONFIRM_MAX = 10;
/** Aceptar invitación (fija contraseña): por IP (el token de invite es el secreto). */
const INVITE_ACCEPT_MAX = 10;
/**
 * Rotación de refresh POR MÉTODO (FIX B, defense-in-depth): @Public (pre-auth, el refreshToken ES el
 * secreto) → ancla en IP. 30/10min frena el abuso de rotación sin molestar al operador legítimo.
 * logout queda @SkipRateLimit (decisión deliberada: cerrar sesión nunca debe ser rate-limiteado).
 */
const REFRESH_MAX = 30;

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
  // Anti-bruteforce del token de invitación POR MÉTODO: 10 cada 10min por IP.
  @RateLimit({ max: INVITE_ACCEPT_MAX, windowMs: TEN_MIN_MS, by: ['ip'] })
  @ApiOperation({ summary: 'Aceptar invitación: el operador fija su contraseña → ACTIVE' })
  acceptInvite(@Body() dto: AcceptInviteDto): Promise<{ email: string }> {
    return this.auth.acceptInvite(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  // Anti-bruteforce de contraseña POR MÉTODO: 10 cada 10min por IP+email (antes: 120/min global/IP).
  @RateLimit({ max: LOGIN_MAX, windowMs: TEN_MIN_MS, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Login email+password; puede devolver challenge de enrolamiento TOTP' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('totp/confirm')
  @HttpCode(200)
  // Anti-bruteforce del código TOTP POR MÉTODO: 10 cada 10min por IP+email.
  @RateLimit({ max: TOTP_CONFIRM_MAX, windowMs: TEN_MIN_MS, by: ['ip', 'email'] })
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
  // FIX B · anti-abuso de rotación POR MÉTODO: 30 cada 10min por IP (pre-auth, ancla en IP).
  @RateLimit({ max: REFRESH_MAX, windowMs: TEN_MIN_MS, by: ['ip'] })
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
