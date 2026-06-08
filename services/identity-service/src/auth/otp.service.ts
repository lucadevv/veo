/**
 * OTP por SMS — thin wrapper sobre VerificationCodeService (lógica unificada de código-en-Redis).
 * Preserva la API pública EXACTA (`issue(phone)`/`verify(phone, code)`), la clave `veo:otp:<phone>`,
 * el TTL/maxAttempts de config y el cooldown de reenvío. El código se guarda HASHEADO; nunca en claro.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { VerificationCodeService } from './verification-code.service';
import type { Env } from '../config/env.schema';

const NAMESPACE = 'otp';
const RESEND_COOLDOWN_MS = 30_000;

@Injectable()
export class OtpService {
  private readonly codes: VerificationCodeService;
  private readonly ttl: number;
  private readonly maxAttempts: number;

  constructor(
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.codes = new VerificationCodeService(redis);
    this.ttl = config.getOrThrow<number>('OTP_TTL_SECONDS');
    this.maxAttempts = config.getOrThrow<number>('OTP_MAX_ATTEMPTS');
  }

  /** Genera y persiste un OTP; devuelve el código en claro SOLO para enviarlo por SMS. */
  async issue(phone: string, now = Date.now()): Promise<string> {
    // namespace 'otp' nunca usa `silent` → issue solo devuelve null bajo cooldown,
    // pero ahí ya lanzó RateLimitError. El `?? ''` es inalcanzable; satisface al tipo.
    const code = await this.codes.issue(
      NAMESPACE,
      phone,
      { ttlSeconds: this.ttl, cooldownMs: RESEND_COOLDOWN_MS, maxAttempts: this.maxAttempts },
      now,
    );
    return code ?? '';
  }

  /** Verifica el OTP. Consume el código si es correcto. */
  async verify(phone: string, code: string): Promise<void> {
    await this.codes.verify(NAMESPACE, phone, code, this.maxAttempts);
  }
}
