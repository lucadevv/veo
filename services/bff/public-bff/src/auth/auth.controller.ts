import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { RateLimit } from '../ratelimit/rate-limit.decorator';
import { AuthService } from './auth.service';

/** Ventanas reutilizadas en los límites estrictos de auth (hardening L1). */
const MIN = 60_000;
const TEN_MIN = 10 * MIN;
const HOUR = 60 * MIN;
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
  // Borde anti-flood SMS: 5 cada 10min por IP+teléfono (identity ya tiene cooldown 30s + maxAttempts).
  @RateLimit({ max: 5, windowMs: TEN_MIN, by: ['ip', 'phone'] })
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
  @ApiOperation({ summary: 'Reenviar el código de verificación de correo' })
  resendEmail(@Body() dto: ResendEmailDto): Promise<EmailSentResult> {
    return this.auth.resendEmail(dto);
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
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
  @ApiOperation({ summary: 'Rotar access/refresh token' })
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
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
