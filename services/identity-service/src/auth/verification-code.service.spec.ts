import { describe, it, expect } from 'vitest';
import { RateLimitError, UnauthorizedError, ConflictError } from '@veo/utils';
import { VerificationCodeService } from './verification-code.service';

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
    _m: m,
  };
}

const NS = 'otp';
const TARGET = '+51987654321';

describe('VerificationCodeService', () => {
  it('emite con la clave veo:<namespace>:<target> y verifica/consume el código', async () => {
    const redis = fakeRedis();
    const svc = new VerificationCodeService(redis as never);
    const code = await svc.issue(NS, TARGET, { ttlSeconds: 300, maxAttempts: 3 });
    expect(code).toMatch(/^\d{6}$/);
    expect(redis._m.has(`veo:${NS}:${TARGET}`)).toBe(true);
    await expect(svc.verify(NS, TARGET, code!, 3)).resolves.toBeUndefined();
    // consumido (single-use) → segundo verify falla
    await expect(svc.verify(NS, TARGET, code!, 3)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza código incorrecto con UnauthorizedError', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await svc.issue(NS, TARGET, { ttlSeconds: 300, maxAttempts: 3 });
    await expect(svc.verify(NS, TARGET, '000000', 3)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('cooldown: lanza RateLimitError dentro de la ventana cuando cooldownMs está definido', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await svc.issue(NS, TARGET, { ttlSeconds: 300, cooldownMs: 30_000, maxAttempts: 3 }, 1000);
    await expect(
      svc.issue(NS, TARGET, { ttlSeconds: 300, cooldownMs: 30_000, maxAttempts: 3 }, 1000 + 5_000),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('silent: bajo cooldown devuelve null en vez de lanzar', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await svc.issue(NS, TARGET, { ttlSeconds: 300, cooldownMs: 30_000, maxAttempts: 3 }, 1000);
    await expect(
      svc.issue(
        NS,
        TARGET,
        { ttlSeconds: 300, cooldownMs: 30_000, maxAttempts: 3, silent: true },
        1000 + 5_000,
      ),
    ).resolves.toBeNull();
  });

  it('sin cooldownMs: re-emite siempre (no rate-limit)', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await svc.issue(NS, TARGET, { ttlSeconds: 300, maxAttempts: 3 }, 1000);
    await expect(
      svc.issue(NS, TARGET, { ttlSeconds: 300, maxAttempts: 3 }, 1000 + 5_000),
    ).resolves.toMatch(/^\d{6}$/);
  });

  it('bloquea al alcanzar maxAttempts (ConflictError) y consume la clave', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await svc.issue(NS, TARGET, { ttlSeconds: 300, maxAttempts: 3 });
    await expect(svc.verify(NS, TARGET, '111111', 3)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(svc.verify(NS, TARGET, '222222', 3)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(svc.verify(NS, TARGET, '333333', 3)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(svc.verify(NS, TARGET, '444444', 3)).rejects.toBeInstanceOf(ConflictError);
  });

  it('verify sin registro previo → UnauthorizedError (expirado/inexistente)', async () => {
    const svc = new VerificationCodeService(fakeRedis() as never);
    await expect(svc.verify(NS, TARGET, '123456', 3)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
