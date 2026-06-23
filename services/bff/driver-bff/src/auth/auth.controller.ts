/**
 * Auth del conductor (passthrough). Endpoints PÚBLICOS (sin JWT), protegidos solo por el
 * rate limiter para evitar abuso del envío de OTP.
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/guards/rate-limit.decorator';
import { AuthService } from './auth.service';
import {
  LogoutDto,
  RefreshDto,
  RequestOtpDto,
  VerifyOtpDto,
  type AuthTokens,
} from './dto/auth.dto';

/** Ventanas reutilizadas en los límites estrictos POR MÉTODO de auth (hardening L1, ADR-012). */
const MINUTE_MS = 60_000;
const TEN_MIN_MS = 10 * MINUTE_MS;
/** Anti-flood SMS POR TELÉFONO: solicitudes de OTP por IP+teléfono (anti-retry del mismo número). */
const OTP_REQUEST_PER_PHONE_MAX = 5;
/**
 * Anti SMS-bombing AGREGADO POR-IP (FIX A): techo del TOTAL de OTP-requests de una IP sin importar el
 * teléfono. El cap fino por IP+teléfono NO acota el fan-out (cada teléfono nuevo abre un cubo fresco
 * de 5), así que una IP fija podía disparar 5 SMS a infinitos números → costo SMS no acotado. 20/10min
 * deja holgado al usuario legítimo (pide 1-2 OTP, a lo sumo reintenta un par de números) pero corta el
 * abuso a ~2 SMS/min/IP como piso de coste. Identity limita por teléfono; ESTO limita el fan-out.
 */
const OTP_REQUEST_PER_IP_MAX = 20;
/** Anti-bruteforce del código OTP: intentos de verificación por IP+teléfono. */
const OTP_VERIFY_MAX = 10;
/**
 * Refresh/logout de token POR MÉTODO (FIX B, defense-in-depth): son @Public (pre-auth, el refreshToken
 * ES el secreto), así que el ancla es la IP (el `user` sería 'anon'). 30/10min frena el abuso de
 * rotación/revocación sin molestar a un cliente legítimo (refresca ~1/15min por la vida del access).
 */
const REFRESH_MAX = 30;
const LOGOUT_MAX = 30;

@ApiTags('auth')
@UseGuards(RateLimitGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  // Borde anti-flood SMS POR MÉTODO en DOS dimensiones (FIX A), ambas evaluadas en la misma request:
  //  (1) 5/10min por IP+teléfono → anti-retry del MISMO número.
  //  (2) 20/10min AGREGADO por-IP → techo del fan-out (total de SMS a teléfonos DISTINTOS desde una IP).
  // identity ya tiene cooldown propio por teléfono; esto acota el coste de SMS en el borde.
  @RateLimit([
    { max: OTP_REQUEST_PER_PHONE_MAX, windowMs: TEN_MIN_MS, by: ['ip', 'phone'] },
    { max: OTP_REQUEST_PER_IP_MAX, windowMs: TEN_MIN_MS, by: ['ip'] },
  ])
  @ApiOperation({ summary: 'Solicitar OTP por SMS para el conductor' })
  requestOtp(@Body() dto: RequestOtpDto): Promise<{ sent: true }> {
    return this.auth.requestOtp(dto.phone);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  // Anti-bruteforce del código POR MÉTODO: 10 intentos cada 10min por IP+teléfono.
  @RateLimit({ max: OTP_VERIFY_MAX, windowMs: TEN_MIN_MS, by: ['ip', 'phone'] })
  @ApiOperation({ summary: 'Verificar OTP y emitir tokens de conductor' })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthTokens> {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  // FIX B · anti-abuso de rotación POR MÉTODO: 30 cada 10min por IP (pre-auth, ancla en IP).
  @RateLimit({ max: REFRESH_MAX, windowMs: TEN_MIN_MS, by: ['ip'] })
  @ApiOperation({ summary: 'Rotar access/refresh token' })
  refresh(@Body() dto: RefreshDto): Promise<AuthTokens> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  // FIX B · anti-abuso de revocación POR MÉTODO: 30 cada 10min por IP.
  @RateLimit({ max: LOGOUT_MAX, windowMs: TEN_MIN_MS, by: ['ip'] })
  @ApiOperation({ summary: 'Revocar la sesión (logout)' })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.auth.logout(dto.refreshToken);
  }
}
