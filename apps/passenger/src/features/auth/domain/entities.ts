/**
 * Entidades de dominio de Auth. El contrato es soberano y vive en `@veo/api-client`
 * (mobile.ts); el dominio sólo re-exporta los tipos como entidades para no duplicar
 * fuentes de verdad.
 */
export type {
  AccountType,
  MobileAuthTokens,
  MobileRefreshResult,
  MobileSessionUser,
  OtpRequest,
  OtpRequestResult,
  OtpVerify,
} from '@veo/api-client';
