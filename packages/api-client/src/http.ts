/**
 * HttpClient mínimo basado en fetch (funciona en navegador y en Node 20+).
 * - `credentials: 'include'` por defecto: las sesiones web viven en cookies httpOnly (sin tokens en JS).
 * - Normaliza errores a ApiError. Valida la respuesta con un schema Zod opcional.
 * - Reintenta GET idempotentes ante errores retryables (red/5xx/429) con backoff.
 */
import type { ZodType, ZodTypeDef } from 'zod';
import { ApiError, type ApiErrorBody } from './errors.js';

export interface HttpClientOptions {
  /** Base URL del BFF, ej. http://localhost:4003/api/v1 */
  baseUrl: string;
  /** Cabeceras por defecto (ej. Accept-Language: es-PE). */
  headers?: Record<string, string>;
  /** include (web, cookies) | omit. Default include. */
  credentials?: RequestCredentials;
  /** Reintentos para GET. Default 2. */
  retries?: number;
  /**
   * Timeout por intento (ms). Default 15000. `0` = sin timeout.
   * Sin esto, un backend inalcanzable (IP LAN equivocada, túnel caído) deja el fetch colgado
   * al timeout TCP del SO (60s+) y la UI muestra un loading eterno sin feedback.
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Schema Zod para validar (y tipar) la respuesta. `T` es el tipo de SALIDA (parseado): el Input va
   * `unknown` a propósito — `ZodType<T>` a secas exige Input=Output y rompe la inferencia con schemas
   * cuyo input difiere del output (`.default()`/`.transform()`, ej. `referralSummary.currency`).
   */
  schema?: ZodType<T, ZodTypeDef, unknown>;
  signal?: AbortSignal;
  /** Override del timeout por intento (ms) para ESTA request. `0` = sin timeout. */
  timeoutMs?: number;
  /** Cabecera Idempotency-Key para POST que lo requieran. */
  idempotencyKey?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly credentials: RequestCredentials;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultHeaders = { Accept: 'application/json', ...opts.headers };
    this.credentials = opts.credentials ?? 'include';
    this.retries = opts.retries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request<T>('POST', path, opts);
  }
  put<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request<T>('PUT', path, opts);
  }
  patch<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request<T>('PATCH', path, opts);
  }
  delete<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request<T>('DELETE', path, opts);
  }

  private buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
    // Construimos el query string manualmente: React Native no implementa
    // `URL.searchParams`, así que `new URL(...).searchParams.set()` lanza excepción.
    // Concatenar a mano es portable entre RN, navegador y Node.
    const base = this.baseUrl + (path.startsWith('/') ? path : `/${path}`);
    if (!query) return base;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    if (parts.length === 0) return base;
    return base + (base.includes('?') ? '&' : '?') + parts.join('&');
  }

  private async request<T>(method: string, path: string, opts: RequestOptions<T>): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...opts.headers };
    let bodyInit: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const maxAttempts = method === 'GET' ? this.retries + 1 : 1;
    let lastErr: ApiError | undefined;

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Timeout por intento vía AbortController, enlazado al signal del caller (si lo hay).
      // Sin esto, un host inalcanzable cuelga el fetch al timeout TCP del SO (60s+) y la UI
      // queda en loading eterno sin feedback.
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onCallerAbort);
      if (opts.signal?.aborted) controller.abort();
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : undefined;
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyInit,
          credentials: this.credentials,
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await this.safeJson<ApiErrorBody>(res);
          const err = ApiError.fromResponse(res.status, errBody);
          if (err.retryable && attempt < maxAttempts) {
            lastErr = err;
            await sleep(150 * attempt);
            continue;
          }
          throw err;
        }
        if (res.status === 204) return undefined as T;
        const data = (await res.json()) as unknown;
        return opts.schema ? opts.schema.parse(data) : (data as T);
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.retryable && attempt < maxAttempts) {
            lastErr = e;
            await sleep(150 * attempt);
            continue;
          }
          throw e;
        }
        // Error de red / abort. El abort por timeout se reporta con mensaje propio (el del
        // runtime es un críptico "Aborted").
        const netErr = new ApiError(
          0,
          'NETWORK_ERROR',
          timedOut
            ? `timeout tras ${timeoutMs}ms sin respuesta de ${url} — ¿backend inalcanzable?`
            : (e as Error).message,
        );
        if (attempt < maxAttempts) {
          lastErr = netErr;
          await sleep(150 * attempt);
          continue;
        }
        throw netErr;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onCallerAbort);
      }
    }
    throw lastErr ?? new ApiError(0, 'NETWORK_ERROR', 'request failed');
  }

  private async safeJson<T>(res: Response): Promise<T | null> {
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
