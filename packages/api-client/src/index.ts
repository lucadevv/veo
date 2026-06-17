/**
 * @veo/api-client
 * Contrato tipado BFF ↔ web (REST + Socket.IO) y cliente HTTP basado en fetch.
 */
export { HttpClient } from './http.js';
export type { HttpClientOptions, RequestOptions } from './http.js';
export {
  ACTIVE_TRIP_EXISTS_CODE,
  ApiError,
  DEBT_PENDING_CODE,
  GATEWAY_CAPABILITY_UNAVAILABLE_CODE,
  KYC_REQUIRED_CODE,
  OFFERING_UNAVAILABLE_CODE,
  activeTripIdFromError,
  debtDetailsFromError,
  gatewayCapabilityFromError,
  isActiveTripExistsError,
  isDebtPendingError,
  isGatewayCapabilityUnavailableError,
  isKycRequiredError,
  isOfferingUnavailableError,
} from './errors.js';
export type { ApiErrorBody, DebtPendingDetails, GatewayCapability } from './errors.js';
export * from './types.js';
export * from './socket.js';
export * from './admin.js';
export * from './mobile.js';
