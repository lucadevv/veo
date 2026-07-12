import {
  type AppleOAuth,
  appleAuthTokens,
  type EmailForgot,
  type EmailForgotResult,
  emailForgotResult,
  type EmailLogin,
  type EmailRegister,
  type EmailRegisterResult,
  emailRegisterResult,
  type EmailResend,
  type EmailResendResult,
  emailResendResult,
  type EmailReset,
  type EmailResetResult,
  emailResetResult,
  type EmailVerify,
  type GoogleOAuth,
  googleAuthTokens,
  type HttpClient,
  type MobileAuthTokens,
  type MobileRefreshResult,
  mobileAuthTokens,
  mobileLogoutResult,
  mobileRefreshResult,
  type OtpRequest,
  type OtpRequestResult,
  otpRequestResult,
  type OtpVerify,
} from '@veo/api-client';
import type {AuthRepository} from '../domain/authRepository';

/**
 * Implementación de `AuthRepository` contra el public-bff (REST `/api/v1`).
 * Real, sin mocks: cada método valida la respuesta con el schema Zod del contrato.
 */
export class HttpAuthRepository implements AuthRepository {
  constructor(private readonly http: HttpClient) {}

  requestOtp(input: OtpRequest): Promise<OtpRequestResult> {
    return this.http.post('/auth/otp/request', {
      body: input,
      schema: otpRequestResult,
    });
  }

  verifyOtp(input: OtpVerify): Promise<MobileAuthTokens> {
    return this.http.post('/auth/otp/verify', {
      body: input,
      schema: mobileAuthTokens,
    });
  }

  refresh(refreshToken: string): Promise<MobileRefreshResult> {
    return this.http.post('/auth/refresh', {
      body: {refreshToken},
      schema: mobileRefreshResult,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.http.post('/auth/logout', {
      body: {refreshToken},
      schema: mobileLogoutResult,
    });
  }

  /* ── Auth por correo + contraseña (ADR-012) ── */

  // DEUDA: (app) el login/registro por email está cableado acá (auth/email/*) y en el BFF, pero NO hay pantalla que lo invoque en el passenger (AuthScreen solo hace phone-OTP + OAuth Google/Apple). Falta EmailLoginScreen para exponerlo.
  registerEmail(input: EmailRegister): Promise<EmailRegisterResult> {
    return this.http.post('/auth/email/register', {
      body: input,
      schema: emailRegisterResult,
    });
  }

  resendEmailCode(input: EmailResend): Promise<EmailResendResult> {
    return this.http.post('/auth/email/resend', {
      body: input,
      schema: emailResendResult,
    });
  }

  verifyEmail(input: EmailVerify): Promise<MobileAuthTokens> {
    return this.http.post('/auth/email/verify', {
      body: input,
      schema: mobileAuthTokens,
    });
  }

  loginEmail(input: EmailLogin): Promise<MobileAuthTokens> {
    return this.http.post('/auth/email/login', {
      body: input,
      schema: mobileAuthTokens,
    });
  }

  forgotPassword(input: EmailForgot): Promise<EmailForgotResult> {
    return this.http.post('/auth/email/forgot', {
      body: input,
      schema: emailForgotResult,
    });
  }

  resetPassword(input: EmailReset): Promise<EmailResetResult> {
    return this.http.post('/auth/email/reset', {
      body: input,
      schema: emailResetResult,
    });
  }

  /* ── Login social nativo (OAuth) ── */

  loginWithGoogle(input: GoogleOAuth): Promise<MobileAuthTokens> {
    return this.http.post('/auth/oauth/google', {
      body: input,
      schema: googleAuthTokens,
    });
  }

  loginWithApple(input: AppleOAuth): Promise<MobileAuthTokens> {
    return this.http.post('/auth/oauth/apple', {
      body: input,
      schema: appleAuthTokens,
    });
  }
}
