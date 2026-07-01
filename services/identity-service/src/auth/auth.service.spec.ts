import { describe, it, expect, vi } from 'vitest';
import { AuthService } from './auth.service';

/**
 * Verifica que verifyOtp engancha el AuthMethod{PHONE_OTP} (ADR-012 Lote 1):
 * - usuario nuevo → create User + create AuthMethod{PHONE_OTP, verified} + outbox, en una tx.
 * - usuario existente → upsert idempotente del AuthMethod (sin recrear el User).
 */
function makePrisma(opts: {
  existing?: { id: string; phone: string; type: string; kycStatus: string };
}) {
  const authMethod = { create: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) };
  const user = {
    findUnique: vi.fn(async () => opts.existing ?? null),
    create: vi.fn(async ({ data }: { data: { phone: string; type: string } }) => ({
      id: 'u-new',
      phone: data.phone,
      type: data.type,
      kycStatus: 'PENDING',
    })),
  };
  const outboxEvent = { create: vi.fn(async () => ({})) };
  const tx = { authMethod, user, outboxEvent };
  const write = {
    ...tx,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { write, read: tx, _m: { authMethod, user, outboxEvent } };
}

const otp = { issue: vi.fn(async () => '123456'), verify: vi.fn(async () => undefined) };
const jwt = {
  signAccessToken: vi.fn(async () => 'at'),
  signRefreshToken: vi.fn(async () => 'rt'),
  verifyRefresh: vi.fn(async () => ({ sub: 'u-1', sid: 's-1', jti: 'j-1' })),
};
const sessions = {
  createSession: vi.fn(async () => ({ sessionId: 's', newJti: 'j' })),
  revoke: vi.fn(async () => undefined),
  revokeAllForUser: vi.fn(async () => 3),
};
const sms = { send: vi.fn(async () => undefined) };
const tokenIssuer = {
  issue: vi.fn(async (_userId: string, _typ: string, user: unknown) => ({
    accessToken: 'at',
    refreshToken: 'rt',
    user,
  })),
};

describe('AuthService.verifyOtp · AuthMethod{PHONE_OTP}', () => {
  it('usuario nuevo: crea User + AuthMethod{PHONE_OTP, verified} + outbox', async () => {
    const prisma = makePrisma({});
    const svc = new AuthService(
      prisma as never,
      otp as never,
      jwt as never,
      sessions as never,
      sms,
      tokenIssuer as never,
    );

    const out = await svc.verifyOtp('+51987654321', '123456', 'PASSENGER');

    expect(out.accessToken).toBe('at');
    expect(prisma._m.user.create).toHaveBeenCalledOnce();
    expect(prisma._m.authMethod.create).toHaveBeenCalledWith({
      data: { userId: 'u-new', type: 'PHONE_OTP', verified: true },
    });
    expect(prisma._m.outboxEvent.create).toHaveBeenCalledOnce();
    expect(prisma._m.authMethod.upsert).not.toHaveBeenCalled();
  });

  it('usuario existente: upsert idempotente del AuthMethod, sin recrear User', async () => {
    const prisma = makePrisma({
      existing: { id: 'u-1', phone: '+51987654321', type: 'PASSENGER', kycStatus: 'PENDING' },
    });
    const svc = new AuthService(
      prisma as never,
      otp as never,
      jwt as never,
      sessions as never,
      sms,
      tokenIssuer as never,
    );

    await svc.verifyOtp('+51987654321', '123456', 'PASSENGER');

    expect(prisma._m.user.create).not.toHaveBeenCalled();
    expect(prisma._m.authMethod.upsert).toHaveBeenCalledWith({
      where: { userId_type: { userId: 'u-1', type: 'PHONE_OTP' } },
      create: { userId: 'u-1', type: 'PHONE_OTP', verified: true },
      update: {},
    });
    expect(prisma._m.outboxEvent.create).not.toHaveBeenCalled();
  });
});

/**
 * logoutAll ("cerrar sesión en todos los dispositivos", ADR-012 §2): verifica el refreshToken (mismo
 * mecanismo que logout), revoca TODAS las sesiones del user vía revokeAllForUser, y es idempotente ante
 * un token inválido.
 */
describe('AuthService.logoutAll · cerrar sesión en todos los dispositivos', () => {
  function makeSvc() {
    const prisma = makePrisma({});
    const svc = new AuthService(
      prisma as never,
      otp as never,
      jwt as never,
      sessions as never,
      sms,
      tokenIssuer as never,
    );
    return svc;
  }

  it('token válido: revoca TODAS las sesiones del user y devuelve { ok, userId }', async () => {
    jwt.verifyRefresh.mockResolvedValueOnce({ sub: 'u-42', sid: 's-1', jti: 'j-1' });
    sessions.revokeAllForUser.mockClear();

    const out = await makeSvc().logoutAll('rt-valido');

    expect(out).toEqual({ ok: true, userId: 'u-42' });
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u-42');
  });

  it('token inválido: idempotente → { ok: true } sin userId y sin revocar', async () => {
    jwt.verifyRefresh.mockRejectedValueOnce(new Error('refresh inválido'));
    sessions.revokeAllForUser.mockClear();

    const out = await makeSvc().logoutAll('rt-basura');

    expect(out).toEqual({ ok: true });
    expect(out.userId).toBeUndefined();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
});
