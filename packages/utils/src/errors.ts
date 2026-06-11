/**
 * Jerarquía única de errores de dominio (FOUNDATION §3).
 * Los servicios lanzan estos; un ExceptionFilter global (@veo/observability) los mapea a HTTP/gRPC.
 * Prohibido `throw new Error(...)` crudo en lógica de negocio.
 */

export interface DomainErrorJSON {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Cuerpo de error del modelo público uniforme (`{ error: { code, message, details? } }`) visto
 * desde el LADO CONSUMIDOR: todo opcional porque el body puede venir de un upstream degradado
 * (proxy, HTML de error, body vacío). FUENTE ÚNICA del contrato: @veo/rpc lo re-exporta como
 * `ApiErrorLike` (BFF→microservicio) y @veo/api-client como `ApiErrorBody` (app→BFF) — antes
 * eran dos definiciones divergentes del MISMO contrato.
 */
export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
  message?: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // Mantener el stack correcto al extender Error nativo.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): DomainErrorJSON {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION';
  readonly httpStatus = 400;
}

export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly httpStatus = 401;
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}

/** Conflicto de idempotencia / recurso duplicado / dedupKey ya visto. */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;
}

/** Transición inválida de máquina de estados (ej. trip COMPLETED → IN_PROGRESS). */
export class InvalidStateError extends DomainError {
  readonly code = 'INVALID_STATE';
  readonly httpStatus = 409;
}

/**
 * Entidad sintácticamente válida pero que no puede procesarse por una precondición de negocio
 * (ej. afiliar Yape sin nombre de perfil cargado). Distinto de 400 (sintaxis) y 409 (conflicto de estado).
 */
export class UnprocessableEntityError extends DomainError {
  readonly code = 'UNPROCESSABLE_ENTITY';
  readonly httpStatus = 422;
}

export class RateLimitError extends DomainError {
  readonly code = 'RATE_LIMIT';
  readonly httpStatus = 429;
}

/** Falla al hablar con un proveedor externo (FaceTec, Yape, LiveKit, Twilio…). */
export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL';
  readonly httpStatus = 502;
}

/**
 * Una CAPACIDAD del proveedor de pagos no está habilitada para el comercio del entorno actual
 * (p.ej. ProntoPaga responde 400 "The payment gateway is not enabled for commerce." al afiliar Yape
 * On File: el comercio de prueba público NO tiene el producto de afiliación activado).
 *
 * NO es transitorio: a diferencia de ExternalServiceError (502, reintentable) o del CF-403
 * (reintentable), reintentar NUNCA va a funcionar hasta que el proveedor habilite el producto en el
 * comercio (tarea comercial L0). Por eso es un error de dominio PROPIO, httpStatus 422 — distinto del
 * 502 UPSTREAM (reintentable) y del 409 INVALID_STATE (estado local) — para que el BFF lo propague
 * LIMPIO (422 < 500 no se aplasta a UPSTREAM_UNAVAILABLE) y la app degrade HONESTO (sin "reintentá").
 * `details.capability` identifica qué capacidad falta (p.ej. 'YAPE_ON_FILE').
 */
export class GatewayCapabilityUnavailableError extends DomainError {
  readonly code = 'GATEWAY_CAPABILITY_UNAVAILABLE';
  readonly httpStatus = 422;
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
