import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { AuthService } from './auth.service';
import { EmailAuthService } from './email-auth.service';
import { GoogleAuthService } from './google-auth.service';
import { AppleAuthService } from './apple-auth.service';
import {
  RequestOtpDto,
  VerifyOtpDto,
  RefreshDto,
  LogoutDto,
  GoogleOAuthDto,
  AppleOAuthDto,
  type AuthTokens,
} from './dto/auth.dto';
import {
  RegisterEmailDto,
  ResendEmailDto,
  VerifyEmailDto,
  LoginEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/email-auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly emailAuth: EmailAuthService,
    private readonly googleAuth: GoogleAuthService,
    private readonly appleAuth: AppleAuthService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Solicitar OTP por SMS (pasajero/conductor)' })
  requestOtp(@Body() dto: RequestOtpDto): Promise<{ sent: true }> {
    return this.auth.requestOtp(dto.phone);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar OTP y emitir tokens' })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthTokens> {
    return this.auth.verifyOtp(dto.phone, dto.code, dto.type);
  }

  @Public()
  @Post('email/register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registrar con correo+contraseña (envía código de verificación)' })
  registerEmail(@Body() dto: RegisterEmailDto): Promise<{ sent: true }> {
    return this.emailAuth.register(dto.email, dto.password, dto.name, dto.type);
  }

  @Public()
  @Post('email/resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenviar el código de verificación de correo (anti-enumeración)' })
  resendEmail(@Body() dto: ResendEmailDto): Promise<{ sent: true }> {
    return this.emailAuth.resendVerification(dto.email);
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar el correo con el código y emitir tokens' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthTokens> {
    return this.emailAuth.verifyEmail(dto.email, dto.code);
  }

  @Public()
  @Post('email/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login con correo+contraseña' })
  loginEmail(@Body() dto: LoginEmailDto): Promise<AuthTokens> {
    return this.emailAuth.login(dto.email, dto.password);
  }

  @Public()
  @Post('email/forgot')
  @HttpCode(200)
  @ApiOperation({ summary: 'Solicitar restablecimiento de contraseña (anti-enumeración)' })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ sent: true }> {
    return this.emailAuth.forgotPassword(dto.email);
  }

  @Public()
  @Post('email/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restablecer contraseña con código y revocar sesiones' })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<{ ok: true }> {
    return this.emailAuth.resetPassword(dto.email, dto.code, dto.newPassword);
  }

  @Public()
  @Post('oauth/google')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login con Google OAuth (verifica el id_token server-side)' })
  loginWithGoogle(@Body() dto: GoogleOAuthDto): Promise<AuthTokens> {
    return this.googleAuth.loginWithGoogle(dto.idToken);
  }

  @Public()
  @Post('oauth/apple')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login con Sign in with Apple (verifica el identityToken server-side)' })
  loginWithApple(@Body() dto: AppleOAuthDto): Promise<AuthTokens> {
    return this.appleAuth.loginWithApple(dto.identityToken);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotar access/refresh token' })
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revocar la sesión (logout)' })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true; userId?: string }> {
    return this.auth.logout(dto.refreshToken);
  }
}
