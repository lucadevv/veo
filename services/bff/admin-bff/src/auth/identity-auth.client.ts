/**
 * Cliente HTTP hacia identity-service para los flujos de auth PRE-autenticación (login, enrolamiento
 * TOTP, refresh, logout). Estos endpoints son @Public en identity (aún no hay Bearer ni identidad que
 * propagar), por lo que se llaman con fetch directo y se mapean los errores con normalizeError de @veo/rpc.
 * Los comandos autenticados (step-up) usan el InternalRestClient firmado, no este cliente.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeError, type ApiErrorLike } from '@veo/rpc';
import { LOGGER, type Logger } from '@veo/observability';
import type { Env } from '../config/env.schema';

@Injectable()
export class IdentityAuthClient {
  private readonly baseUrl: string;
  private readonly timeoutMs = 8000;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.baseUrl = config.get('IDENTITY_URL', { infer: true }).replace(/\/$/, '');
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errBody = (await this.safeJson(res)) as ApiErrorLike | null;
        throw normalizeError(res.status, errBody);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      this.logger.debug('respuesta de identity sin cuerpo JSON');
      return null;
    }
  }
}
