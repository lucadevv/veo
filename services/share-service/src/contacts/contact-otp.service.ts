/**
 * OTP de verificación de contactos de confianza sobre Redis (BR-I06).
 * El código se guarda HASHEADO con TTL; nunca en claro. Rate-limit de reenvío + límite de intentos.
 * Mismo patrón que identity-service ports/sms + auth/otp, pero namespaced para contactos.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  numericOtp,
  sha256Hex,
  ConflictError,
  RateLimitError,
  UnauthorizedError,
} from '@veo/utils';
import { REDIS } from '../infra/redis';
import type { Env } from '../config/env.schema';

interface OtpRecord {
  hash: string;
  attempts: number;
  issuedAt: number;
}

const RESEND_COOLDOWN_MS = 30_000;

@Injectable()
export class ContactOtpService {
  private readonly ttl: number;
  private readonly maxAttempts: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttl = config.getOrThrow<number>('OTP_TTL_SECONDS');
    this.maxAttempts = config.getOrThrow<number>('OTP_MAX_ATTEMPTS');
  }

  private key(contactId: string): string {
    return `veo:share:contact-otp:${contactId}`;
  }

  /** Genera y persiste un OTP para un contacto; devuelve el código en claro SOLO para enviarlo por SMS. */
  async issue(contactId: string, now = Date.now()): Promise<string> {
    const existing = await this.redis.get(this.key(contactId));
    if (existing) {
      const rec = JSON.parse(existing) as OtpRecord;
      if (now - rec.issuedAt < RESEND_COOLDOWN_MS) {
        throw new RateLimitError('Espera unos segundos antes de pedir otro código');
      }
    }
    const code = numericOtp(6);
    const rec: OtpRecord = { hash: sha256Hex(code), attempts: 0, issuedAt: now };
    await this.redis.set(this.key(contactId), JSON.stringify(rec), 'EX', this.ttl);
    return code;
  }

  /** Verifica el OTP de un contacto. Consume el código si es correcto. */
  async verify(contactId: string, code: string): Promise<void> {
    const raw = await this.redis.get(this.key(contactId));
    if (!raw) throw new UnauthorizedError('Código expirado o inexistente. Solicita uno nuevo.');
    const rec = JSON.parse(raw) as OtpRecord;

    if (rec.attempts >= this.maxAttempts) {
      await this.redis.del(this.key(contactId));
      throw new ConflictError('Demasiados intentos. Solicita un nuevo código.');
    }

    if (sha256Hex(code) !== rec.hash) {
      rec.attempts += 1;
      const remaining = await this.redis.ttl(this.key(contactId));
      await this.redis.set(this.key(contactId), JSON.stringify(rec), 'EX', Math.max(remaining, 1));
      throw new UnauthorizedError('Código incorrecto');
    }

    await this.redis.del(this.key(contactId));
  }
}
