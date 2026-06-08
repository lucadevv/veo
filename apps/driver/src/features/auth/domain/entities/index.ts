import type {
  MobileLogoutRequest,
  MobileLogoutResult,
  MobileRefreshRequest,
  MobileRefreshResult,
  MobileSessionUser,
  OtpRequest,
  OtpRequestResult,
  OtpVerify,
} from '@veo/api-client';

/**
 * Entidades del dominio de autenticación. Se apoyan en los tipos del contrato `@veo/api-client`
 * (fuente de verdad BFF↔app) mediante alias, para no duplicar formas ni desincronizarse.
 *
 * NOTA DE CONTRATO: `POST /auth/otp/verify` del driver-bff devuelve SOLO `{ accessToken, refreshToken }`
 * (no incluye `user`, a diferencia de `MobileAuthTokens`). Por eso `AuthTokens` aquí son solo los
 * tokens; el usuario de sesión se obtiene aparte vía `GET /drivers/me` (ver `LoginUseCase`).
 */
export type AuthTokens = MobileRefreshResult;
export type SessionUser = MobileSessionUser;
export type OtpRequestInput = OtpRequest;
export type OtpRequestOutcome = OtpRequestResult;
export type OtpVerifyInput = OtpVerify;
export type RefreshInput = MobileRefreshRequest;
export type RefreshResult = MobileRefreshResult;
export type LogoutInput = MobileLogoutRequest;
export type LogoutResult = MobileLogoutResult;
