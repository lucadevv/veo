import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RateLimitError, UnauthorizedError, ConflictError } from '@veo/utils';
import { EmailCodeService } from './email-code.service';
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
      return 600;
    },
  };
}

const config = new ConfigService<Env, true>({
  EMAIL_VERIFY_TTL_SECONDS: 600,
  PWD_RESET_TTL_SECONDS: 3600,
  EMAIL_CODE_MAX_ATTEMPTS: 5,
});

const EMAIL = 'ada@veo.pe';

describe('EmailCodeService', () => {
  it('emite y verifica un código correcto (y lo consume)', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    const code = await svc.issue('email-verify', EMAIL);
    expect(code).toMatch(/^\d{6}$/);
    await expect(svc.verify('email-verify', EMAIL, code!)).resolves.toBeUndefined();
    // consumido → segundo intento falla
    await expect(svc.verify('email-verify', EMAIL, code!)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza código incorrecto', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    await svc.issue('pwd-reset', EMAIL);
    await expect(svc.verify('pwd-reset', EMAIL, '000000')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('verifica código expirado/inexistente como UnauthorizedError', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    await expect(svc.verify('email-verify', EMAIL, '123456')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('aplica cooldown de reenvío (lanza por defecto)', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    await svc.issue('email-verify', EMAIL, {}, 1000);
    await expect(svc.issue('email-verify', EMAIL, {}, 1000 + 5_000)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('silent: bajo cooldown devuelve null en vez de lanzar (anti-enumeración)', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    await svc.issue('pwd-reset', EMAIL, {}, 1000);
    await expect(svc.issue('pwd-reset', EMAIL, { silent: true }, 1000 + 5_000)).resolves.toBeNull();
  });

  it('bloquea tras agotar intentos (ConflictError)', async () => {
    const svc = new EmailCodeService(fakeRedis() as never, config);
    await svc.issue('email-verify', EMAIL);
    for (let i = 0; i < 5; i++) {
      await expect(svc.verify('email-verify', EMAIL, '111111')).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
    // 6º intento: contador alcanzó el máximo → ConflictError
    await expect(svc.verify('email-verify', EMAIL, '222222')).rejects.toBeInstanceOf(ConflictError);
  });
});
