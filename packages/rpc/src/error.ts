/** Normalización de errores downstream para que el BFF los remapee a su modelo público. */
import type { ApiErrorBody } from '@veo/utils';

/**
 * Alias del contrato único `ApiErrorBody` (@veo/utils). Mismo shape que parsea @veo/api-client:
 * los microservicios y los BFFs emiten el MISMO modelo de error, así que el tipo vive UNA vez.
 */
export type ApiErrorLike = ApiErrorBody;

export class DownstreamError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DownstreamError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(status: number, body: ApiErrorLike | null): DownstreamError {
  const code = body?.error?.code ?? 'DOWNSTREAM_ERROR';
  const message = body?.error?.message ?? body?.message ?? `downstream ${status}`;
  return new DownstreamError(status, code, message, body?.error?.details);
}
