/**
 * Cliente REST interno BFF→microservicio para comandos. Firma la identidad del usuario
 * (validado por el BFF vía JWT) con HMAC y la propaga en cabeceras; el servicio la verifica
 * con InternalIdentityGuard. NUNCA reenvía el JWT crudo aguas abajo.
 */
import {
  signInternalIdentity,
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  type AuthenticatedUser,
} from '@veo/auth';
import { normalizeError, type ApiErrorLike } from './error.js';

export interface InternalRestOptions {
  /** Base del servicio, ej. http://localhost:3002/api/v1 */
  baseUrl: string;
  /** Secreto HMAC compartido (VEO_INTERNAL_IDENTITY_SECRET). */
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface InternalRequest {
  /** Usuario autenticado por el BFF, a propagar como identidad interna. */
  identity: AuthenticatedUser;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class InternalRestClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: InternalRestOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get<T>(path: string, req: InternalRequest): Promise<T> {
    return this.request<T>('GET', path, req);
  }
  post<T>(path: string, req: InternalRequest): Promise<T> {
    return this.request<T>('POST', path, req);
  }
  put<T>(path: string, req: InternalRequest): Promise<T> {
    return this.request<T>('PUT', path, req);
  }
  patch<T>(path: string, req: InternalRequest): Promise<T> {
    return this.request<T>('PATCH', path, req);
  }
  delete<T>(path: string, req: InternalRequest): Promise<T> {
    return this.request<T>('DELETE', path, req);
  }

  private async request<T>(method: string, path: string, req: InternalRequest): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const { header, signature } = signInternalIdentity(req.identity, this.secret);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [INTERNAL_IDENTITY_HEADER]: header,
      [INTERNAL_IDENTITY_SIG_HEADER]: signature,
      ...req.headers,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = req.signal ?? ctrl.signal;
    try {
      const res = await this.fetchImpl(url.toString(), { method, headers, body, signal });
      if (!res.ok) {
        const errBody = (await safeJson(res)) as ApiErrorLike | null;
        throw normalizeError(res.status, errBody);
      }
      if (res.status === 204) return undefined as T;
      // Un handler que devuelve `null` (ej. "no hay consent vigente") produce un 200 con cuerpo VACÍO;
      // `res.json()` sobre cuerpo vacío tira SyntaxError. Leemos texto y mapeamos vacío → null.
      const text = await res.text();
      return (text.length > 0 ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
