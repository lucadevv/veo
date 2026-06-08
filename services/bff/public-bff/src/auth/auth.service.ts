/**
 * Passthrough de autenticación hacia identity-service (endpoints públicos: pre-autenticación).
 * No hay usuario autenticado todavía, así que se usa una identidad interna anónima (los endpoints
 * de auth del downstream son @Public y la ignoran). NUNCA se reenvía un JWT crudo.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient } from '@veo/rpc';
import { REST_IDENTITY } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../infra/internal-identity';
import type { Env } from '../config/env.schema';
import {
  PANIC_SIGNATURE_VERSION,
  type AuthTokens,
  type EmailOkResult,
  type EmailSentResult,
  type AppleOAuthDto,
  type ForgotPasswordDto,
  type GoogleOAuthDto,
  type LoginEmailDto,
  type LogoutDto,
  type PanicKey,
  type RefreshDto,
  type RegisterEmailDto,
  type RequestOtpDto,
  type ResendEmailDto,
  type ResetPasswordDto,
  type VerifyEmailDto,
  type VerifyOtpDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(REST_IDENTITY) private readonly identity: InternalRestClient,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Devuelve el secreto HMAC COMPARTIDO de pánico y la versión del mensaje canónico.
   * Modelo actual del servicio: secreto compartido (no per-user). El cliente firma el cuerpo del
   * POST /panic con este secreto; panic-service lo verifica con el mismo valor.
   */
  getPanicKey(): PanicKey {
    return {
      secret: this.config.getOrThrow<string>('PANIC_HMAC_SECRET'),
      version: PANIC_SIGNATURE_VERSION,
    };
  }

  requestOtp(dto: RequestOtpDto): Promise<{ sent: true }> {
    return this.identity.post<{ sent: true }>('/auth/otp/request', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  verifyOtp(dto: VerifyOtpDto): Promise<AuthTokens> {
    return this.identity.post<AuthTokens>('/auth/otp/verify', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  /* ── Auth por correo + contraseña (ADR-012). Passthrough @Public a identity-service. ── */

  registerEmail(dto: RegisterEmailDto): Promise<EmailSentResult> {
    return this.identity.post<EmailSentResult>('/auth/email/register', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  resendEmail(dto: ResendEmailDto): Promise<EmailSentResult> {
    return this.identity.post<EmailSentResult>('/auth/email/resend', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  verifyEmail(dto: VerifyEmailDto): Promise<AuthTokens> {
    return this.identity.post<AuthTokens>('/auth/email/verify', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  loginEmail(dto: LoginEmailDto): Promise<AuthTokens> {
    return this.identity.post<AuthTokens>('/auth/email/login', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  forgotPassword(dto: ForgotPasswordDto): Promise<EmailSentResult> {
    return this.identity.post<EmailSentResult>('/auth/email/forgot', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  resetPassword(dto: ResetPasswordDto): Promise<EmailOkResult> {
    return this.identity.post<EmailOkResult>('/auth/email/reset', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  /* ── Login con Google OAuth (ADR-012 Lote 3). identity verifica el id_token server-side. ── */

  loginWithGoogle(dto: GoogleOAuthDto): Promise<AuthTokens> {
    return this.identity.post<AuthTokens>('/auth/oauth/google', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  /* ── Login con Apple (App Store Guideline 4.8). identity verifica el identityToken server-side. ── */

  loginWithApple(dto: AppleOAuthDto): Promise<AuthTokens> {
    return this.identity.post<AuthTokens>('/auth/oauth/apple', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.identity.post<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }

  logout(dto: LogoutDto): Promise<{ ok: true }> {
    return this.identity.post<{ ok: true }>('/auth/logout', {
      identity: ANONYMOUS_IDENTITY,
      body: dto,
    });
  }
}
