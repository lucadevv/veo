/** Normalización de errores downstream para que el BFF los remapee a su modelo público. */
export interface ApiErrorLike {
  error?: { code?: string; message?: string; details?: unknown };
  message?: string;
}

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
