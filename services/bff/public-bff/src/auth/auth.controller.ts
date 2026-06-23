import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { RateLimit } from '../ratelimit/rate-limit.decorator';
import { AuthService } from './auth.service';

/** Ventanas reutilizadas en los límites estrictos de auth (hardening L1). */
const MIN = 60_000;
const TEN_MIN = 10 * MIN;
const HOUR = 60 * MIN;

/* ── Caps nombrados POR MÉTODO (sin números mágicos sueltos; coherentes con driver-bff). ── */
/** OTP por teléfono: anti-retry del mismo número (5/10min por IP+teléfono). */
const OTP_REQUEST_PER_PHONE_MAX = 5;
/**
 * OTP AGREGADO por-IP (FIX A): techo del TOTAL de OTP-requests de una IP sin importar el teléfono. El
 * cap fino por IP+teléfono NO acota el fan-out (cada número nuevo abre un cubo fresco de 5), así que
 * una IP fija podía disparar SMS a infinitos teléfonos-víctima → coste no acotado. 20/10min no molesta
 * al usuario legítimo (1-2 OTP) pero corta el SMS-bombing. Espeja driver-bff.
 */
const OTP_REQUEST_PER_IP_MAX = 20;
/** Reenvío de código de verificación de correo (spam de email): estricto como forgot, 3/hora por IP+email. */
const EMAIL_RESEND_MAX = 3;
/** Verificación de código de correo (fuerza bruta del código): 10/10min por IP+email. */
const EMAIL_VERIFY_MAX = 10;
/** Reset de contraseña con código (fuerza bruta del código de reset): 10/10min por IP+email. */
const EMAIL_RESET_MAX = 10;
/**
 * Refresh/logout de token POR MÉTODO (defense-in-depth): son @Public (pre-auth, el refreshToken ES el
 * secreto), así que el ancla es la IP (el `user` sería 'anon'). 30/10min frena el abuso de
 * rotación/revocación sin molestar a un cliente legítimo. Espeja driver-bff (coherencia entre BFFs).
 */
const REFRESH_MAX = 30;
const LOGOUT_MAX = 30;
import {
  AppleOAuthDto,
  ForgotPasswordDto,
  GoogleOAuthDto,
  LoginEmailDto,
  LogoutDto,
  RefreshDto,
  RegisterEmailDto,
  RequestOtpDto,
  ResendEmailDto,
  ResetPasswordDto,
  VerifyEmailDto,
  VerifyOtpDto,
  type AuthTokens,
  type EmailOkResult,
  type EmailSentResult,
  type PanicKey,
} from './dto/auth.dto';

/** Passthrough de auth (pre-autenticación): todos los endpoints son públicos. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  // Borde anti-flood SMS en DOS dimensiones (FIX A), ambas evaluadas en la misma request:
  //  (1) 5/10min por IP+teléfono → anti-retry del MISMO número.
  //  (2) 20/10min AGREGADO por-IP → techo del fan-out (SMS a teléfonos DISTINTOS desde una IP).
  // identity ya tiene cooldown 30s + maxAttempts por teléfono; esto acota el coste de SMS en el borde.
  @RateLimit([
    { max: OTP_REQUEST_PER_PHONE_MAX, windowMs: TEN_MIN, by: ['ip', 'phone'] },
    { max: OTP_REQUEST_PER_IP_MAX, windowMs: TEN_MIN, by: ['ip'] },
  ])
  @ApiOperation({ summary: 'Solicitar código de verificación (WhatsApp con respaldo SMS)' })
  requestOtp(@Body() dto: RequestOtpDto): Promise<{ sent: true }> {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  // Anti-bruteforce del código: 10 intentos cada 10min por IP+teléfono (identity limita por teléfono).
  @RateLimit({ max: 10, windowMs: TEN_MIN, by: ['ip', 'phone'] })
  @ApiOperation({ summary: 'Verificar OTP y emitir tokens' })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthTokens> {
    return this.auth.verifyOtp(dto);
  }

  /* ── Auth por correo + contraseña (ADR-012). Todos @Public (pre-autenticación). ── */

  @Public()
  @Post('email/register')
  @HttpCode(200)
  // Anti-abuso de alta + envío de correo: 5 por hora por IP+email.
  @RateLimit({ max: 5, windowMs: HOUR, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Registrar por correo y enviar código de verificación' })
  registerEmail(@Body() dto: RegisterEmailDto): Promise<EmailSentResult> {
    return this.auth.registerEmail(dto);
  }

  @Public()
  @Post('email/resend')
  @HttpCode(200)
  // FIX B · spam de correo (reenvía el código de verificación): estricto como forgot, 3/hora por IP+email.
  @RateLimit({ max: EMAIL_RESEND_MAX, windowMs: HOUR, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Reenviar el código de verificación de correo' })
  resendEmail(@Body() dto: ResendEmailDto): Promise<EmailSentResult> {
    return this.auth.resendEmail(dto);
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  // FIX B · fuerza bruta del código de verificación: 10 cada 10min por IP+email (como email/login).
  @RateLimit({ max: EMAIL_VERIFY_MAX, windowMs: TEN_MIN, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Verificar correo y emitir tokens' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthTokens> {
    return this.auth.verifyEmail(dto);
  }

  @Public()
  @Post('email/login')
  @HttpCode(200)
  // Anti-bruteforce de contraseña: 10 cada 10min por IP+email.
  @RateLimit({ max: 10, windowMs: TEN_MIN, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Iniciar sesión con correo y contraseña' })
  loginEmail(@Body() dto: LoginEmailDto): Promise<AuthTokens> {
    return this.auth.loginEmail(dto);
  }

  @Public()
  @Post('email/forgot')
  @HttpCode(200)
  // Anti-abuso de reset (enumeración + spam de correo): 3 por hora por IP+email.
  @RateLimit({ max: 3, windowMs: HOUR, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Solicitar código para restablecer la contraseña' })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<EmailSentResult> {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('email/reset')
  @HttpCode(200)
  // FIX B · fuerza bruta del código de reset: 10 cada 10min por IP+email.
  @RateLimit({ max: EMAIL_RESET_MAX, windowMs: TEN_MIN, by: ['ip', 'email'] })
  @ApiOperation({ summary: 'Restablecer la contraseña con el código' })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<EmailOkResult> {
    return this.auth.resetPassword(dto);
  }

  @Public()
  @Post('oauth/google')
  @HttpCode(200)
  // Anti-abuso de OAuth (fuerza bruta de id_token / spam de verificación): 10 cada 10min por IP.
  // El body no porta phone/email estables (vienen del id_token verificado server-side), así que la IP
  // es el ancla del borde; identity valida el id_token contra Google y es la defensa de fondo.
  @RateLimit({ max: 10, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({ summary: 'Iniciar sesión con Google (verifica el id_token server-side)' })
  loginWithGoogle(@Body() dto: GoogleOAuthDto): Promise<AuthTokens> {
    return this.auth.loginWithGoogle(dto);
  }

  @Public()
  @Post('oauth/apple')
  @HttpCode(200)
  // Anti-abuso de OAuth (fuerza bruta de identityToken / spam de verificación): 10 cada 10min por IP.
  // Mismo criterio que google: la IP es el ancla del borde; identity valida el identityToken contra
  // Apple y es la defensa de fondo.
  @RateLimit({ max: 10, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({ summary: 'Iniciar sesión con Apple (verifica el identityToken server-side)' })
  loginWithApple(@Body() dto: AppleOAuthDto): Promise<AuthTokens> {
    return this.auth.loginWithApple(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  // Anti-abuso de rotación de token: 30/10min por IP (mismo criterio que driver-bff).
  @RateLimit({ max: REFRESH_MAX, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({ summary: 'Rotar access/refresh token' })
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  // Anti-abuso de revocación de sesión: 30/10min por IP (mismo criterio que driver-bff).
  @RateLimit({ max: LOGOUT_MAX, windowMs: TEN_MIN, by: ['ip'] })
  @ApiOperation({ summary: 'Revocar la sesión (logout)' })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.auth.logout(dto);
  }

  /**
   * Devuelve el secreto HMAC COMPARTIDO de pánico (modelo actual del servicio, no per-user) y la
   * versión del mensaje canónico. Requiere JWT de pasajero (no es @Public). El cliente firma con
   * este secreto el cuerpo del POST /panic.
   */
  @Get('panic-key')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Secreto HMAC compartido para firmar pánico (BR-S04)' })
  panicKey(): PanicKey {
    return this.auth.getPanicKey();
  }
}
