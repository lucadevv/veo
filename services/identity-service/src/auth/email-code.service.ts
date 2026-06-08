/**
 * Códigos efímeros de correo (verificación de cuenta + reset de contraseña) — thin wrapper sobre
 * VerificationCodeService (lógica unificada de código-en-Redis). Preserva la API pública EXACTA
 * (`issue(purpose, email, opts)`/`verify(purpose, email, code)`), la clave `veo:<purpose>:<email>`,
 * los TTL por propósito, el cooldown, maxAttempts y el modo `silent` (anti-enumeración en forgot).
 * NUNCA se guarda el código en claro (ADR-012 §2: Redis TTL, hash sha256).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { VerificationCodeService } from './verification-code.service';
import type { Env } from '../config/env.schema';

/** Propósito del código → prefijo de clave Redis + TTL aplicado. */
export type EmailCodePurpose = 'email-verify' | 'pwd-reset';

const RESEND_COOLDOWN_MS = 30_000;

@Injectable()
export class EmailCodeService {
  private readonly codes: VerificationCodeService;
  private readonly verifyTtl: number;
  private readonly resetTtl: number;
  private readonly maxAttempts: number;

  constructor(
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.codes = new VerificationCodeService(redis);
    this.verifyTtl = config.getOrThrow<number>('EMAIL_VERIFY_TTL_SECONDS');
    this.resetTtl = config.getOrThrow<number>('PWD_RESET_TTL_SECONDS');
    this.maxAttempts = config.getOrThrow<number>('EMAIL_CODE_MAX_ATTEMPTS');
  }

  private ttlFor(purpose: EmailCodePurpose): number {
    return purpose === 'pwd-reset' ? this.resetTtl : this.verifyTtl;
  }

  /**
   * Genera y persiste un código; devuelve el código en claro SOLO para enviarlo por correo.
   * `silent`: si hay cooldown vigente, devuelve null en vez de lanzar (para anti-enumeración en forgot).
   */
  async issue(
    purpose: EmailCodePurpose,
    email: string,
    opts: { silent?: boolean } = {},
    now = Date.now(),
  ): Promise<string | null> {
    return this.codes.issue(
      purpose,
      email,
      {
        ttlSeconds: this.ttlFor(purpose),
        cooldownMs: RESEND_COOLDOWN_MS,
        maxAttempts: this.maxAttempts,
        silent: opts.silent,
      },
      now,
    );
  }

  /** Verifica el código. Lo consume (un solo uso) si es correcto. */
  async verify(purpose: EmailCodePurpose, email: string, code: string): Promise<void> {
    await this.codes.verify(purpose, email, code, this.maxAttempts);
  }
}
