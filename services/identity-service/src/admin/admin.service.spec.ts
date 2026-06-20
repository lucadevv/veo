import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { enrollTotp, generateTotp } from '@veo/auth';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  SystemClock,
  FixedClock,
  type Clock,
} from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { AdminService } from './admin.service';
import { InvalidStatusTransition } from '../domain/state-machine';
import { hashInviteToken } from '../domain/invite-token';
import { seal } from '../common/secret-box';
import type { EmailSender } from '../ports/email/email.port';
import type { Env } from '../config/env.schema';

const TOTP_ENC_KEY = 'k'.repeat(32);

const config = new ConfigService<Env, true>({
  TOTP_ENC_KEY,
  ADMIN_WEB_URL: 'http://localhost:5001',
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_LOCK_SECONDS: 900,
});

/** Redis doble basado en Map (mismo patrón que email-auth.service.spec). */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async incr(k: string) {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return next;
    },
    async expire() {
      return 1;
    },
    _store: store,
  };
}

/** EmailSender doble que registra envíos; por defecto resuelve OK. */
function makeEmail(impl?: () => Promise<void>): EmailSender & { sent: number } {
  const sender = {
    sent: 0,
    async send() {
      sender.sent += 1;
      if (impl) await impl();
    },
  };
  return sender;
}

function makeService(
  prisma: unknown,
  email: EmailSender = makeEmail(),
  redis: unknown = fakeRedis(),
  jwt: unknown = {},
  sessions: unknown = {},
  clock: Clock = new SystemClock(),
): AdminService {
  return new AdminService(
    prisma as never,
    jwt as never,
    sessions as never,
    email,
    redis as never,
    clock,
    config,
  );
}

/** Prisma doble: reject lee y escribe DENTRO de la tx (la réplica devuelve estado posiblemente viejo). */
function makeRejectPrisma(replicaAdmin: unknown, txAdmin: unknown = replicaAdmin) {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    prisma: {
      read: { adminUser: { findUnique: async () => replicaAdmin } },
      write: {
        $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
          fn({
            adminUser: {
              findUnique: async () => txAdmin,
              update: async ({ data }: { data: Record<string, unknown> }) => {
                writes.push(data);
                return { id: 'a1', ...data };
              },
            },
          }),
      },
    },
  };
}

describe('AdminService.reject · anti-escalada + máquina dentro de la tx', () => {
  const SUPER = [AdminRole.SUPERADMIN];
  const target = (status: string) => ({ id: 'a1', status, roles: [AdminRole.SUPPORT_L1] });

  it('un SUPERADMIN rechaza un PENDING de menor rango → REJECTED', async () => {
    const { prisma, writes } = makeRejectPrisma(target('PENDING'));
    await makeService(prisma).reject(SUPER, 'super', 'a1');
    expect(writes).toEqual([{ status: 'REJECTED' }]);
  });

  it('rechaza un INVITED → REJECTED (revocar invitación)', async () => {
    const { prisma, writes } = makeRejectPrisma(target('INVITED'));
    await makeService(prisma).reject(SUPER, 'super', 'a1');
    expect(writes).toEqual([{ status: 'REJECTED' }]);
  });

  it('ANTI-ESCALADA: un ADMIN no puede rechazar a un SUPERADMIN → 403 con CERO writes', async () => {
    const { prisma, writes } = makeRejectPrisma({
      id: 'a1',
      status: 'ACTIVE',
      roles: [AdminRole.SUPERADMIN],
    });
    await expect(makeService(prisma).reject([AdminRole.ADMIN], 'admin', 'a1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(writes).toHaveLength(0);
  });

  it('ANTI-ESCALADA: nadie se deshabilita a sí mismo → 403 con CERO writes', async () => {
    const { prisma, writes } = makeRejectPrisma({
      id: 'self',
      status: 'ACTIVE',
      roles: [AdminRole.SUPERADMIN],
    });
    await expect(makeService(prisma).reject(SUPER, 'self', 'self')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(writes).toHaveLength(0);
  });

  it('reject TOCTOU: la réplica decía PENDING pero la tx ve un estado inválido → 409 con CERO writes', async () => {
    const { prisma, writes } = makeRejectPrisma(target('PENDING'), {
      id: 'a1',
      status: 'LEGACY_GARBAGE',
      roles: [AdminRole.SUPPORT_L1],
    });
    await expect(makeService(prisma).reject(SUPER, 'super', 'a1')).rejects.toBeInstanceOf(
      InvalidStatusTransition,
    );
    expect(writes).toHaveLength(0);
  });

  it('reject concurrente que ya dejó REJECTED: re-aplicación idempotente (no-op válido por diseño)', async () => {
    const { prisma, writes } = makeRejectPrisma(target('PENDING'), {
      id: 'a1',
      status: 'REJECTED',
      roles: [AdminRole.SUPPORT_L1],
    });
    await expect(makeService(prisma).reject(SUPER, 'super', 'a1')).resolves.toBeUndefined();
    expect(writes).toEqual([{ status: 'REJECTED' }]);
  });

  it('reject: 404 si el operador no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, writes } = makeRejectPrisma(target('PENDING'), null);
    await expect(makeService(prisma).reject(SUPER, 'super', 'a1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(writes).toHaveLength(0);
  });
});

/**
 * Prisma doble para createOperator: read.findUnique (chequeo de email) + write.create.
 * Los spies permiten afirmar que la escalada CORTA antes de tocar la DB.
 */
function makeCreatePrisma(existing: unknown = null) {
  const findUnique = vi.fn(async () => existing);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'a1',
    ...data,
  }));
  return {
    findUnique,
    create,
    prisma: {
      read: { adminUser: { findUnique } },
      write: { adminUser: { create } },
    },
  };
}

describe('AdminService.createOperator · alta por invitación + anti-escalada', () => {
  it('ADMIN → [SUPERADMIN]: ForbiddenError 403 SIN tocar la DB', async () => {
    const { prisma, findUnique, create } = makeCreatePrisma();
    const err = await makeService(prisma)
      .createOperator([AdminRole.ADMIN], 'op@veo.pe', [AdminRole.SUPERADMIN])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).httpStatus).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rol fuera del enum → ValidationError ANTES del check de jerarquía y sin tocar DB', async () => {
    const { prisma, findUnique, create } = makeCreatePrisma();
    await expect(
      makeService(prisma).createOperator(
        [AdminRole.SUPERADMIN],
        'op@veo.pe',
        ['NO_EXISTE' as AdminRole],
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('ADMIN → [SUPPORT_L2]: crea INVITED con token y devuelve el inviteUrl', async () => {
    const { prisma, create } = makeCreatePrisma();
    const email = makeEmail();
    const res = await makeService(prisma, email).createOperator([AdminRole.ADMIN], 'op@veo.pe', [
      AdminRole.SUPPORT_L2,
    ]);
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.status).toBe('INVITED');
    expect(data.passwordHash).toBeNull();
    expect(data.inviteTokenHash).toEqual(expect.any(String));
    // El token en claro NUNCA se persiste; en la DB va solo su hash.
    expect(data.inviteTokenHash).not.toBe(res.inviteToken);
    expect(hashInviteToken(res.inviteToken)).toBe(data.inviteTokenHash);
    expect(res.inviteUrl).toBe(`http://localhost:5001/accept-invite?token=${res.inviteToken}`);
    expect(email.sent).toBe(1);
  });

  it('email ya tomado → ConflictError', async () => {
    const { prisma } = makeCreatePrisma({ id: 'x', email: 'op@veo.pe' });
    await expect(
      makeService(prisma).createOperator([AdminRole.ADMIN], 'op@veo.pe', [AdminRole.SUPPORT_L2]),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('degradación honesta: si el email falla, createOperator NO falla y devuelve el inviteUrl', async () => {
    const { prisma } = makeCreatePrisma();
    const email = makeEmail(async () => {
      throw new Error('SMTP caído');
    });
    const res = await makeService(prisma, email).createOperator([AdminRole.ADMIN], 'op@veo.pe', [
      AdminRole.SUPPORT_L2,
    ]);
    expect(res.inviteToken).toEqual(expect.any(String));
    expect(res.inviteUrl).toContain('/accept-invite?token=');
  });
});

/**
 * Prisma doble para acceptInvite: read.findFirst (por hash+INVITED) + tx (findUnique + update).
 */
function makeAcceptPrisma(found: Record<string, unknown> | null, txFresh?: Record<string, unknown> | null) {
  const writes: Record<string, unknown>[] = [];
  const fresh = txFresh === undefined ? found : txFresh;
  return {
    writes,
    prisma: {
      read: { adminUser: { findFirst: async () => found } },
      write: {
        $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
          fn({
            adminUser: {
              findUnique: async () => fresh,
              update: async ({ data }: { data: Record<string, unknown> }) => {
                writes.push(data);
                return { id: 'a1', ...data };
              },
            },
          }),
      },
    },
  };
}

describe('AdminService.acceptInvite · fija contraseña → ACTIVE (un solo uso)', () => {
  const TOKEN = 'plain-token-abc';
  const tokenHash = hashInviteToken(TOKEN);
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  it('token válido + no expirado → ACTIVE, limpia el hash y devuelve el email', async () => {
    const { prisma, writes } = makeAcceptPrisma({
      id: 'a1',
      email: 'op@veo.pe',
      status: 'INVITED',
      inviteTokenHash: tokenHash,
      inviteExpiresAt: future,
    });
    const res = await makeService(prisma).acceptInvite(TOKEN, 'una-clave-larga');
    expect(res).toEqual({ email: 'op@veo.pe' });
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.status).toBe('ACTIVE');
    expect(write.inviteTokenHash).toBeNull();
    expect(write.inviteExpiresAt).toBeNull();
    expect(write.passwordHash).toEqual(expect.any(String));
  });

  it('token inexistente / ya usado (findFirst null) → UnauthorizedError, CERO writes', async () => {
    const { prisma, writes } = makeAcceptPrisma(null);
    await expect(makeService(prisma).acceptInvite(TOKEN, 'una-clave-larga')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(writes).toHaveLength(0);
  });

  it('invitación expirada → UnauthorizedError, CERO writes', async () => {
    const { prisma, writes } = makeAcceptPrisma({
      id: 'a1',
      email: 'op@veo.pe',
      status: 'INVITED',
      inviteTokenHash: tokenHash,
      inviteExpiresAt: past,
    });
    await expect(makeService(prisma).acceptInvite(TOKEN, 'una-clave-larga')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(writes).toHaveLength(0);
  });

  it('carrera: otro accept ya limpió el hash dentro de la tx → UnauthorizedError, CERO writes', async () => {
    const { prisma, writes } = makeAcceptPrisma(
      {
        id: 'a1',
        email: 'op@veo.pe',
        status: 'INVITED',
        inviteTokenHash: tokenHash,
        inviteExpiresAt: future,
      },
      // El estado fresco dentro de la tx ya no tiene el token (consumido por otra request).
      { id: 'a1', email: 'op@veo.pe', status: 'ACTIVE', inviteTokenHash: null },
    );
    await expect(makeService(prisma).acceptInvite(TOKEN, 'una-clave-larga')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(writes).toHaveLength(0);
  });
});

/**
 * Prisma doble para reinvite: read.findUnique + write.update.
 */
function makeReinvitePrisma(admin: Record<string, unknown> | null) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'a1', ...data }));
  return {
    update,
    prisma: {
      read: { adminUser: { findUnique: async () => admin } },
      write: { adminUser: { update } },
    },
  };
}

describe('AdminService.reinvite · re-emite invitación solo si sigue INVITED', () => {
  it('INVITED → regenera token+expiración y devuelve nuevo inviteUrl', async () => {
    const { prisma, update } = makeReinvitePrisma({
      id: 'a1',
      email: 'op@veo.pe',
      status: 'INVITED',
      roles: [AdminRole.SUPPORT_L2],
    });
    const res = await makeService(prisma).reinvite([AdminRole.ADMIN], 'a1');
    expect(update).toHaveBeenCalledOnce();
    expect(res.inviteUrl).toContain('/accept-invite?token=');
  });

  it('operador ya ACTIVE → ConflictError', async () => {
    const { prisma } = makeReinvitePrisma({
      id: 'a1',
      email: 'op@veo.pe',
      status: 'ACTIVE',
      roles: [AdminRole.SUPPORT_L2],
    });
    await expect(makeService(prisma).reinvite([AdminRole.ADMIN], 'a1')).rejects.toMatchObject({
      httpStatus: 409,
    });
  });

  it('404 si el operador no existe', async () => {
    const { prisma } = makeReinvitePrisma(null);
    await expect(makeService(prisma).reinvite([AdminRole.ADMIN], 'a1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

/**
 * Lockout anti brute-force en el login admin (Lote 2 hardening). Copia el patrón de
 * email-auth.service.spec: fakeRedis Map-based, fallos de password Y de TOTP cuentan bajo la misma
 * clave del email, login exitoso limpia, lock corta ANTES de comparar.
 */
describe('AdminService.login · lockout anti brute-force', () => {
  const EMAIL = 'op@veo.pe';
  const PASSWORD = 'una-clave-larga-segura';
  const ATTEMPTS_KEY = `veo:admin-login-attempts:${EMAIL}`;
  const LOCK_KEY = `veo:admin-login-lock:${EMAIL}`;

  /** Operador ACTIVE con password real (argon2) y TOTP enrolado a partir de un secret sellado. */
  async function makeActiveAdmin(): Promise<{ admin: Record<string, unknown>; secret: string }> {
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const { secret } = enrollTotp(EMAIL);
    return {
      secret,
      admin: {
        id: 'a1',
        email: EMAIL,
        status: 'ACTIVE',
        roles: [AdminRole.SUPPORT_L1],
        passwordHash,
        totpEnrolled: true,
        totpSecretEnc: seal(secret, TOTP_ENC_KEY),
      },
    };
  }

  /** Prisma doble de login: read.findUnique({email}) devuelve el admin; write.update no-op. */
  function makeLoginPrisma(admin: Record<string, unknown>) {
    return {
      read: { adminUser: { findUnique: async () => admin } },
      write: { adminUser: { update: async () => admin } },
    };
  }

  function makeSessions() {
    return { createSession: vi.fn(async () => ({ sessionId: 'sid-1', newJti: 'jti-1' })) };
  }

  function makeJwt() {
    return {
      signAccessToken: vi.fn(async () => 'access-token'),
      signRefreshToken: vi.fn(async () => 'refresh-token'),
    };
  }

  it('5 fallos de password → el 6º se rechaza con RateLimitError aun con password CORRECTA', async () => {
    const { admin } = await makeActiveAdmin();
    const redis = fakeRedis();
    const svc = makeService(makeLoginPrisma(admin), makeEmail(), redis);

    for (let i = 0; i < 5; i++) {
      await expect(svc.login(EMAIL, 'password-incorrecta')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(redis._store.get(LOCK_KEY)).toBeDefined();

    // 6º intento con la password correcta → 429 ANTES de comparar.
    await expect(svc.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('el lock rechaza ANTES de comparar la contraseña / tocar la DB', async () => {
    const { admin } = await makeActiveAdmin();
    const redis = fakeRedis();
    redis._store.set(LOCK_KEY, '1');
    // Si comparara, este hash corrupto haría reventar argon2; el lock corta antes.
    const tampered = { ...admin, passwordHash: 'tampered' };
    const svc = makeService(makeLoginPrisma(tampered), makeEmail(), redis);
    await expect(svc.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('TOTP incorrecto tras password correcta también cuenta como fallo (brute-force del código)', async () => {
    const { admin } = await makeActiveAdmin();
    const redis = fakeRedis();
    const svc = makeService(makeLoginPrisma(admin), makeEmail(), redis, makeJwt(), makeSessions());

    await expect(svc.login(EMAIL, PASSWORD, '000000')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis._store.get(ATTEMPTS_KEY)).toBe('1');
  });

  it('login exitoso (password + TOTP válidos) limpia el contador y el lock', async () => {
    const { admin, secret } = await makeActiveAdmin();
    const redis = fakeRedis();
    const svc = makeService(makeLoginPrisma(admin), makeEmail(), redis, makeJwt(), makeSessions());

    // 3 fallos por debajo del tope → contador en 3, sin lock.
    for (let i = 0; i < 3; i++) {
      await expect(svc.login(EMAIL, 'password-incorrecta')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(redis._store.get(ATTEMPTS_KEY)).toBe('3');

    const validTotp = generateTotp(secret);
    const tokens = await svc.login(EMAIL, PASSWORD, validTotp);
    expect(tokens).toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(redis._store.get(ATTEMPTS_KEY)).toBeUndefined();
    expect(redis._store.get(LOCK_KEY)).toBeUndefined();
  });

  it('DETERMINISTA: con un FixedClock inyectado, el login verifica el TOTP en ESE instante (incl. 2026)', async () => {
    const { admin, secret } = await makeActiveAdmin();
    const redis = fakeRedis();
    // Reloj fijado a 2026: el servicio NO depende del reloj de pared para verificar el código.
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const svc = makeService(makeLoginPrisma(admin), makeEmail(), redis, makeJwt(), makeSessions(), clock);

    // El código se genera para EL MISMO instante del reloj inyectado.
    const totpAt2026 = generateTotp(secret, clock.now());
    const tokens = await svc.login(EMAIL, PASSWORD, totpAt2026);
    expect(tokens).toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });

  it('DETERMINISTA: un código de hace 60s NO verifica (el servicio usa el clock inyectado, fuera de ventana)', async () => {
    const { admin, secret } = await makeActiveAdmin();
    const redis = fakeRedis();
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const svc = makeService(makeLoginPrisma(admin), makeEmail(), redis, makeJwt(), makeSessions(), clock);

    // Código generado 60s ANTES del instante del reloj del servicio → fuera de window:1.
    const staleTotp = generateTotp(secret, clock.now() - 60_000);
    await expect(svc.login(EMAIL, PASSWORD, staleTotp)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
