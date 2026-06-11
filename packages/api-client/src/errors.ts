/**
 * Error normalizado del cliente. Los BFFs responden con el modelo de error de @veo/utils
 * ({ error: { code, message, details? } }); aquí lo normalizamos a una clase tipada.
 * `ApiErrorBody` es la FUENTE ÚNICA del shape (vive en @veo/utils, junto a DomainError);
 * acá se re-exporta para que las apps lo sigan importando de @veo/api-client.
 */
import type { ApiErrorBody } from '@veo/utils';

export type { ApiErrorBody } from '@veo/utils';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** true si conviene reintentar (red / 5xx / 429). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  static fromResponse(status: number, body: ApiErrorBody | string | null): ApiError {
    if (typeof body === 'string') return new ApiError(status, 'HTTP_ERROR', body || `HTTP ${status}`);
    const code = body?.error?.code ?? 'HTTP_ERROR';
    const message = body?.error?.message ?? body?.message ?? `HTTP ${status}`;
    return new ApiError(status, code, message, body?.error?.details);
  }
}

/**
 * Código (422) cuando una CAPACIDAD del proveedor de pagos no está habilitada para el comercio del
 * entorno actual (p.ej. afiliación Yape On File en un comercio que no tiene el producto activado). NO es
 * transitorio: reintentar nunca va a funcionar hasta que el proveedor lo habilite (tarea comercial L0).
 * La app degrada HONESTO (banner informativo, sin "reintentá"). Contrato server-side; no hardcodear.
 * Viaja limpio porque httpStatus 422 (< 500) NO se aplasta a UPSTREAM_UNAVAILABLE en el BFF.
 */
export const GATEWAY_CAPABILITY_UNAVAILABLE_CODE = 'GATEWAY_CAPABILITY_UNAVAILABLE';

/** Capacidades del gateway que pueden faltar en un comercio (las que la app distingue). */
export type GatewayCapability = 'YAPE_ON_FILE' | (string & {});

/**
 * true si el error es una capacidad del proveedor NO habilitada para el comercio (422
 * `GATEWAY_CAPABILITY_UNAVAILABLE`). La app lo usa para degradar honesto (banner calmo, sin "reintentá")
 * en vez de tratarlo como un fallo transitorio (UPSTREAM/CF → "el servicio está ocupado").
 */
export function isGatewayCapabilityUnavailableError(err: unknown): boolean {
  return err instanceof ApiError && err.code === GATEWAY_CAPABILITY_UNAVAILABLE_CODE;
}

/**
 * Extrae la `capability` que falta (p.ej. 'YAPE_ON_FILE') de un 422 `GATEWAY_CAPABILITY_UNAVAILABLE`
 * (`details.capability`), o `null` si el error no es ese o no la trae.
 */
export function gatewayCapabilityFromError(err: unknown): GatewayCapability | null {
  if (!isGatewayCapabilityUnavailableError(err)) return null;
  const details = (err as ApiError).details;
  if (details && typeof details === 'object' && 'capability' in details) {
    const cap = (details as { capability?: unknown }).capability;
    return typeof cap === 'string' ? cap : null;
  }
  return null;
}

/**
 * Código del BFF (403) cuando el pasajero debe verificar su identidad (liveness/KYC) antes de pedir
 * un viaje. Es el contrato entre el gate server-side de public-bff y las apps; no hardcodear el string.
 */
export const KYC_REQUIRED_CODE = 'KYC_REQUIRED';

/** true si el error es el gate de verificación facial del BFF (403 `KYC_REQUIRED`). */
export function isKycRequiredError(err: unknown): boolean {
  return err instanceof ApiError && err.code === KYC_REQUIRED_CODE;
}

/**
 * Código del BFF (403) cuando el pasajero tiene una DEUDA pendiente (un cobro en DEBT) y pide un viaje
 * nuevo. La deuda bloquea TODO pedido (decisión de producto). El `details` lleva `{ debtTotalCents,
 * oldestTripId }` para que la app muestre el banner "salda tu deuda" con el monto y derive a saldar.
 * Contrato entre el gate server-side de public-bff y las apps; no hardcodear el string.
 */
export const DEBT_PENDING_CODE = 'DEBT_PENDING';

/** true si el error es el gate de deuda del BFF (403 `DEBT_PENDING`). */
export function isDebtPendingError(err: unknown): boolean {
  return err instanceof ApiError && err.code === DEBT_PENDING_CODE;
}

/** Detalle del gate de deuda: total adeudado (céntimos PEN) y el viaje impago más antiguo. */
export interface DebtPendingDetails {
  debtTotalCents: number;
  oldestTripId: string | null;
}

/**
 * Extrae `{ debtTotalCents, oldestTripId }` de un 403 `DEBT_PENDING` (`details`), o `null` si el error
 * no es ese. La app lo usa para pintar el banner de deuda con el monto y enlazar a "saldar".
 */
export function debtDetailsFromError(err: unknown): DebtPendingDetails | null {
  if (!isDebtPendingError(err)) return null;
  const details = (err as ApiError).details;
  if (!details || typeof details !== 'object') return null;
  const d = details as { debtTotalCents?: unknown; oldestTripId?: unknown };
  return {
    debtTotalCents: typeof d.debtTotalCents === 'number' ? d.debtTotalCents : 0,
    oldestTripId: typeof d.oldestTripId === 'string' ? d.oldestTripId : null,
  };
}

/**
 * Código del BFF (409) cuando el pasajero ya tiene un viaje VIVO y pide otro ("una sola experiencia de
 * viaje"). El `details.activeTripId` apunta al viaje en curso para que la app lo lleve de vuelta a él
 * (re-entrada al flujo unificado) en vez de mostrar un error. Contrato server-side; no hardcodear.
 */
export const ACTIVE_TRIP_EXISTS_CODE = 'ACTIVE_TRIP_EXISTS';

/** true si el error es el gate "ya tenés un viaje en curso" del BFF (409 `ACTIVE_TRIP_EXISTS`). */
export function isActiveTripExistsError(err: unknown): boolean {
  return err instanceof ApiError && err.code === ACTIVE_TRIP_EXISTS_CODE;
}

/**
 * Id del viaje activo embebido en un 409 `ACTIVE_TRIP_EXISTS` (`details.activeTripId`), o `null` si el
 * error no es ese o no trae el id. La app lo usa para re-entrar al viaje en curso.
 */
export function activeTripIdFromError(err: unknown): string | null {
  if (!isActiveTripExistsError(err)) return null;
  const details = (err as ApiError).details;
  if (details && typeof details === 'object' && 'activeTripId' in details) {
    const id = (details as { activeTripId?: unknown }).activeTripId;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
