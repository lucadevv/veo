import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RateLimitError, UnauthorizedError, ConflictError } from '@veo/utils';
import { ContactOtpService } from './contact-otp.service';
import type { Env } from '../config/env.schema';

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async set(k: string, v: string) {
      m.set(k, v);
      return 'OK';
    },
    async del(k: string) {
      return m.delete(k) ? 1 : 0;
    },
    async ttl() {
      return 300;
    },
  };
}

const config = new ConfigService<Env, true>({ OTP_TTL_SECONDS: 300, OTP_MAX_ATTEMPTS: 3 });
const CONTACT = 'contact-1';

describe('ContactOtpService (BR-I06)', () => {
  it('emite y verifica un OTP correcto (y lo consume)', async () => {
    const otp = new ContactOtpService(fakeRedis() as never, config);
    const code = await otp.issue(CONTACT, 1000);
    expect(code).toMatch(/^\d{6}$/);
    await expect(otp.verify(CONTACT, code)).resolves.toBeUndefined();
    // consumido → segundo intento falla
    await expect(otp.verify(CONTACT, code)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza un código incorrecto', async () => {
    const otp = new ContactOtpService(fakeRedis() as never, config);
    await otp.issue(CONTACT, 1000);
    await expect(otp.verify(CONTACT, '000000')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('aplica cooldown de reenvío', async () => {
    const otp = new ContactOtpService(fakeRedis() as never, config);
    await otp.issue(CONTACT, 1000);
    await expect(otp.issue(CONTACT, 1000 + 5_000)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('bloquea tras agotar intentos', async () => {
    const otp = new ContactOtpService(fakeRedis() as never, config);
    await otp.issue(CONTACT, 1000);
    await expect(otp.verify(CONTACT, '111111')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(otp.verify(CONTACT, '222222')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(otp.verify(CONTACT, '333333')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(otp.verify(CONTACT, '444444')).rejects.toBeInstanceOf(ConflictError);
  });
});
