import type {
  AuthTokens,
  LogoutInput,
  LogoutResult,
  OtpRequestInput,
  OtpRequestOutcome,
  OtpVerifyInput,
  RefreshInput,
  RefreshResult,
} from '../entities';

/**
 * Contrato del repositorio de autenticación (capa domain).
 * Habla con el driver-bff vía OTP por teléfono. La implementación concreta vive en `data/`.
 */
export interface AuthRepository {
  /** POST /auth/otp/request — solicita el envío del código OTP. */
  requestOtp(input: OtpRequestInput): Promise<OtpRequestOutcome>;
  /** POST /auth/otp/verify — verifica el OTP y devuelve tokens + usuario de sesión. */
  verifyOtp(input: OtpVerifyInput): Promise<AuthTokens>;
  /** POST /auth/refresh — rota el access/refresh token. */
  refresh(input: RefreshInput): Promise<RefreshResult>;
  /** POST /auth/logout — invalida el refresh token. */
  logout(input: LogoutInput): Promise<LogoutResult>;
}
