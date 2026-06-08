/**
 * VerificationCodeService — lógica unificada de "código efímero en Redis" (ADR-012, hardening DRY).
 * Antes vivía DUPLICADA en OtpService (SMS) y EmailCodeService (correo). Patrón único:
 *   - código numérico de 6 dígitos, HASHEADO (sha256) — nunca en claro en Redis.
 *   - registro JSON { hash, attempts, issuedAt } con TTL.
 *   - cooldown de reenvío (opcional) anti-spam.
 *   - límite de intentos (maxAttempts) anti brute-force → bloqueo (ConflictError) y consumo de la clave.
 *   - single-use: al acertar se borra la clave (DEL).
 *   - `silent`: bajo cooldown devuelve null en vez de lanzar (anti-enumeración, p.ej. forgot-password).
 *
 * Clave Redis: `veo:<namespace>:<target>` (ej. `veo:otp:<phone>`, `veo:email-verify:<email>`).
 */
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  numericOtp,
  sha256Hex,
  ConflictError,
  RateLimitError,
  UnauthorizedError,
} from '@veo/utils';
import { REDIS } from '../infra/redis';

interface CodeRecord {
  hash: string;
  attempts: number;
  issuedAt: number;
}

/** Opciones de emisión. `cooldownMs` ausente → sin cooldown de reenvío. */
export interface IssueOptions {
  ttlSeconds: number;
  cooldownMs?: number;
  maxAttempts: number;
  silent?: boolean;
}

@Injectable()
export class VerificationCodeService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(namespace: string, target: string): string {
    return `veo:${namespace}:${target}`;
  }

  /**
   * Genera y persiste un código; devuelve el código en claro SOLO para entregarlo por el canal externo.
   * Aplica cooldown si `cooldownMs` está definido. `silent` devuelve null en cooldown en vez de lanzar.
   */
  async issue(
    namespace: string,
    target: string,
    opts: IssueOptions,
    now = Date.now(),
  ): Promise<string | null> {
    const key = this.key(namespace, target);
    if (opts.cooldownMs !== undefined) {
      const existing = await this.redis.get(key);
      if (existing) {
        const rec = JSON.parse(existing) as CodeRecord;
        if (now - rec.issuedAt < opts.cooldownMs) {
          if (opts.silent) return null;
          throw new RateLimitError('Espera unos segundos antes de pedir otro código');
        }
      }
    }
    const code = numericOtp(6);
    const rec: CodeRecord = { hash: sha256Hex(code), attempts: 0, issuedAt: now };
    await this.redis.set(key, JSON.stringify(rec), 'EX', opts.ttlSeconds);
    return code;
  }

  /** Verifica el código. Cuenta intentos, bloquea al tope (ConflictError) y consume (DEL) al acertar. */
  async verify(
    namespace: string,
    target: string,
    code: string,
    maxAttempts: number,
  ): Promise<void> {
    const key = this.key(namespace, target);
    const raw = await this.redis.get(key);
    if (!raw) throw new UnauthorizedError('Código expirado o inexistente. Solicita uno nuevo.');
    const rec = JSON.parse(raw) as CodeRecord;

    if (rec.attempts >= maxAttempts) {
      await this.redis.del(key);
      throw new ConflictError('Demasiados intentos. Solicita un nuevo código.');
    }

    if (sha256Hex(code) !== rec.hash) {
      rec.attempts += 1;
      const remaining = await this.redis.ttl(key);
      await this.redis.set(key, JSON.stringify(rec), 'EX', Math.max(remaining, 1));
      throw new UnauthorizedError('Código incorrecto');
    }

    await this.redis.del(key);
  }
}
