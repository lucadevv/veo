import type {
  AppleOAuth,
  EmailForgot,
  EmailForgotResult,
  EmailLogin,
  EmailRegister,
  EmailRegisterResult,
  EmailResend,
  EmailResendResult,
  EmailReset,
  EmailResetResult,
  EmailVerify,
  GoogleOAuth,
  MobileAuthTokens,
  MobileRefreshResult,
  OtpRequest,
  OtpRequestResult,
  OtpVerify,
} from '@veo/api-client';

/**
 * Abstracción del repositorio de Auth (DIP). La capa de presentación/UseCases depende
 * de esta interfaz; la implementación concreta (data) habla con el public-bff.
 */
export interface AuthRepository {
  /** POST /auth/otp/request → solicita el envío del OTP. */
  requestOtp(input: OtpRequest): Promise<OtpRequestResult>;
  /** POST /auth/otp/verify → verifica el OTP y devuelve tokens + usuario. */
  verifyOtp(input: OtpVerify): Promise<MobileAuthTokens>;
  /** POST /auth/refresh → renueva los tokens. */
  refresh(refreshToken: string): Promise<MobileRefreshResult>;
  /** POST /auth/logout → invalida el refresh token en el servidor. */
  logout(refreshToken: string): Promise<void>;

  /* ── Auth por correo + contraseña (ADR-012) ── */
  /** POST /auth/email/register → crea la cuenta y envía el código (NO emite tokens). */
  registerEmail(input: EmailRegister): Promise<EmailRegisterResult>;
  /** POST /auth/email/resend → reenvía el código de verificación (anti-enumeración: siempre {sent:true}). */
  resendEmailCode(input: EmailResend): Promise<EmailResendResult>;
  /** POST /auth/email/verify → verifica el código y devuelve tokens + usuario. */
  verifyEmail(input: EmailVerify): Promise<MobileAuthTokens>;
  /** POST /auth/email/login → autentica por correo+contraseña y devuelve tokens + usuario. */
  loginEmail(input: EmailLogin): Promise<MobileAuthTokens>;
  /** POST /auth/email/forgot → solicita el código de restablecimiento (anti-enumeración). */
  forgotPassword(input: EmailForgot): Promise<EmailForgotResult>;
  /** POST /auth/email/reset → cambia la contraseña con el código de un solo uso. */
  resetPassword(input: EmailReset): Promise<EmailResetResult>;

  /* ── Login social nativo (OAuth) ── */
  /**
   * POST /auth/oauth/google → reenvía el `idToken` de Google Sign-In (nativo) al backend, que lo
   * verifica soberanamente contra el JWKS de Google y devuelve tokens + usuario.
   */
  loginWithGoogle(input: GoogleOAuth): Promise<MobileAuthTokens>;
  /**
   * POST /auth/oauth/apple → reenvía el `identityToken` de Sign in with Apple (nativo) al backend,
   * que lo verifica soberanamente contra el JWKS de Apple y devuelve tokens + usuario.
   */
  loginWithApple(input: AppleOAuth): Promise<MobileAuthTokens>;
}
