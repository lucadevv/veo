import type { HttpClient } from '@veo/api-client';
import { mobileLogoutResult, mobileRefreshResult, otpRequestResult } from '@veo/api-client';
import type {
  AuthRepository,
  AuthTokens,
  LogoutInput,
  LogoutResult,
  OtpRequestInput,
  OtpRequestOutcome,
  OtpVerifyInput,
  RefreshInput,
  RefreshResult,
} from '../../domain';

/**
 * Implementación HTTP del `AuthRepository` contra el driver-bff (`/api/v1`).
 * Cada respuesta se valida con el schema zod del contrato (`@veo/api-client`).
 */
export class HttpAuthRepository implements AuthRepository {
  constructor(private readonly http: HttpClient) {}

  requestOtp(input: OtpRequestInput): Promise<OtpRequestOutcome> {
    return this.http.post('/auth/otp/request', { body: input, schema: otpRequestResult });
  }

  verifyOtp(input: OtpVerifyInput): Promise<AuthTokens> {
    // El driver-bff responde solo con `{ accessToken, refreshToken }` (sin `user`); validamos con el
    // schema de tokens. El usuario de sesión se resuelve después con `GET /drivers/me`.
    return this.http.post('/auth/otp/verify', { body: input, schema: mobileRefreshResult });
  }

  refresh(input: RefreshInput): Promise<RefreshResult> {
    return this.http.post('/auth/refresh', { body: input, schema: mobileRefreshResult });
  }

  logout(input: LogoutInput): Promise<LogoutResult> {
    return this.http.post('/auth/logout', { body: input, schema: mobileLogoutResult });
  }
}
