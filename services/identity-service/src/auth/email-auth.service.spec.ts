import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '@veo/utils';
import { EmailAuthService } from './email-auth.service';
import { EmailAuthRepository } from './email-auth.repository';
import type { Env } from '../config/env.schema';

/**
 * Doble de Prisma en memoria: modela `user` + `authMethod` lo justo para register/verify/login/reset.
 * Soporta findUnique por compuesto (type_email, userId_type), create, update, y $transaction.
 */
interface UserRow {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  type: 'PASSENGER' | 'DRIVER';
  kycStatus: string;
}
interface MethodRow {
  id: string;
  userId: string;
  type: string;
  email: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
  verified: boolean;
}

function makePrisma() {
  const users: UserRow[] = [];
  const methods: MethodRow[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const findMethod = (where: Record<string, unknown>): MethodRow | undefined => {
    if (where.type_email) {
      const { type, email } = where.type_email as { type: string; email: string };
      return methods.find((m) => m.type === type && m.email === email);
    }
    if (where.id) return methods.find((m) => m.id === where.id);
    return undefined;
  };

  const authMethod = {
    findUnique: vi.fn(
      async ({
        where,
        include,
      }: {
        where: Record<string, unknown>;
        include?: { user?: boolean };
      }) => {
        const m = findMethod(where);
        if (!m) return null;
        if (include?.user) return { ...m, user: users.find((u) => u.id === m.userId)! };
        return { ...m };
      },
    ),
    // Account-linking: busca un AuthMethod verificado por email (cualquier tipo).
    findFirst: vi.fn(async ({ where }: { where: { email?: string; emailVerified?: boolean } }) => {
      const m = methods.find(
        (x) =>
          (where.email === undefined || x.email === where.email) &&
          (where.emailVerified === undefined || x.emailVerified === where.emailVerified),
      );
      return m ? { ...m } : null;
    }),
    create: vi.fn(
      async ({ data }: { data: Partial<MethodRow> & { userId: string; type: string } }) => {
        const row: MethodRow = {
          id: nextId('am'),
          userId: data.userId,
          type: data.type,
          email: data.email ?? null,
          passwordHash: data.passwordHash ?? null,
          emailVerified: data.emailVerified ?? false,
          verified: data.verified ?? false,
        };
        methods.push(row);
        return { ...row };
      },
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MethodRow> }) => {
      const m = methods.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return { ...m };
    }),
  };

  const user = {
    create: vi.fn(async ({ data }: { data: Partial<UserRow> }) => {
      const row: UserRow = {
        id: nextId('u'),
        phone: data.phone ?? null,
        email: data.email ?? null,
        name: data.name ?? null,
        type: data.type ?? 'PASSENGER',
        kycStatus: 'PENDING',
      };
      users.push(row);
      return { ...row };
    }),
  };

  const outboxEvent = { create: vi.fn(async () => ({})) };

  const client = { authMethod, user, outboxEvent };
  const write = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };

  return {
    read: client,
    write,
    _state: { users, methods },
    /** Primer AuthMethod (siempre presente en los tests que lo usan). */
    method0(): MethodRow {
      const m = methods[0];
      if (!m) throw new Error('no auth method en el estado del mock');
      return m;
    },
  };
}

function makeSessions() {
  return {
    revokeAllForUser: vi.fn(async () => 1),
  };
}

/** TokenIssuerService doble: emite el par fijo que esperan las aserciones. */
function makeTokenIssuer() {
  return {
    issue: vi.fn(
      async (_userId: string, _typ: string, user: { id: string; email?: string | null }) => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user,
      }),
    ),
  };
}

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

const ENV = new ConfigService<Env, true>({ LOGIN_MAX_ATTEMPTS: 5, LOGIN_LOCK_SECONDS: 900 });

function makeCodes() {
  return {
    issue: vi.fn(async () => '123456'),
    verify: vi.fn(async () => undefined),
  };
}

function makeEmail() {
  return { send: vi.fn(async () => undefined) };
}

const STRONG_PASSWORD = 'Sup3rSecretPass!';
const EMAIL = 'Ada@Veo.PE';
const NORM = 'ada@veo.pe';

function build() {
  const prisma = makePrisma();
  const sessions = makeSessions();
  const codes = makeCodes();
  const email = makeEmail();
  const redis = fakeRedis();
  const tokenIssuer = makeTokenIssuer();
  const svc = new EmailAuthService(
    new EmailAuthRepository(prisma as never),
    sessions as never,
    codes as never,
    email,
    redis as never,
    tokenIssuer as never,
    ENV,
  );
  return { svc, prisma, sessions, codes, email, redis, tokenIssuer };
}

describe('EmailAuthService.register', () => {
  it('correo nuevo: crea User + AuthMethod{EMAIL_PASSWORD, no verificado}, envía código y NO emite tokens', async () => {
    const { svc, prisma, codes, email } = build();
    const out = await svc.register(EMAIL, STRONG_PASSWORD, 'Ada', 'PASSENGER');

    expect(out).toEqual({ sent: true });
    expect(prisma._state.users).toHaveLength(1);
    expect(prisma._state.methods).toHaveLength(1);
    const m = prisma.method0();
    expect(m.type).toBe('EMAIL_PASSWORD');
    expect(m.email).toBe(NORM); // normalizado a minúsculas
    expect(m.emailVerified).toBe(false);
    expect(m.passwordHash).toMatch(/^\$argon2id\$/);
    expect(codes.issue).toHaveBeenCalledWith('email-verify', NORM);
    expect(email.send).toHaveBeenCalledOnce();
  });

  it('rechaza contraseña corta (< 12) con ValidationError', async () => {
    const { svc } = build();
    await expect(svc.register(EMAIL, 'corta123', undefined, 'PASSENGER')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('duplicado VERIFICADO → ConflictError "iniciá sesión"', async () => {
    const { svc, prisma } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    prisma.method0().emailVerified = true;
    await expect(
      svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('duplicado SIN verificar → reenvía código, no error, no crea otro método', async () => {
    const { svc, prisma, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    codes.issue.mockClear();
    const out = await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    expect(out).toEqual({ sent: true });
    expect(prisma._state.methods).toHaveLength(1);
    expect(codes.issue).toHaveBeenCalledWith('email-verify', NORM);
  });
});

describe('EmailAuthService.resendVerification (anti-enumeración)', () => {
  it('cuenta existente SIN verificar → reenvía el código de verificación y {sent:true}', async () => {
    const { svc, email, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    email.send.mockClear();
    codes.issue.mockClear();

    const out = await svc.resendVerification(EMAIL);
    expect(out).toEqual({ sent: true });
    expect(codes.issue).toHaveBeenCalledWith('email-verify', NORM);
    expect(email.send).toHaveBeenCalledOnce();
  });

  it('cuenta YA verificada → {sent:true} SIN reenviar (no filtra el estado)', async () => {
    const { svc, prisma, email, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    prisma.method0().emailVerified = true;
    email.send.mockClear();
    codes.issue.mockClear();

    const out = await svc.resendVerification(EMAIL);
    expect(out).toEqual({ sent: true });
    expect(codes.issue).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('cuenta inexistente → {sent:true} SIN reenviar (no filtra el estado)', async () => {
    const { svc, email, codes } = build();
    const out = await svc.resendVerification('ghost@veo.pe');
    expect(out).toEqual({ sent: true });
    expect(codes.issue).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('cuenta sin verificar en cooldown → propaga RateLimitError (consistente con register)', async () => {
    const { svc, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    codes.issue.mockRejectedValueOnce(new RateLimitError('Espera unos segundos'));
    await expect(svc.resendVerification(EMAIL)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('EmailAuthService.verifyEmail', () => {
  it('código ok → marca emailVerified+verified y emite tokens', async () => {
    const { svc, prisma } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    const out = await svc.verifyEmail(EMAIL, '123456');
    expect(out.accessToken).toBe('access-token');
    expect(out.refreshToken).toBe('refresh-token');
    expect(out.user.email).toBe(NORM);
    expect(prisma.method0().emailVerified).toBe(true);
    expect(prisma.method0().verified).toBe(true);
  });

  it('código inválido/expirado → propaga UnauthorizedError (no emite tokens)', async () => {
    const { svc, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    codes.verify.mockRejectedValueOnce(new UnauthorizedError('Código expirado'));
    await expect(svc.verifyEmail(EMAIL, '999999')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('emite outbox user.email_verified (userId, email, verifiedAt) en la misma tx', async () => {
    const { svc, prisma } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    const userId = prisma._state.users[0]!.id;
    prisma.write.outboxEvent.create.mockClear();

    await svc.verifyEmail(EMAIL, '123456');

    expect(prisma.write.outboxEvent.create).toHaveBeenCalledOnce();
    const calls = prisma.write.outboxEvent.create.mock.calls as unknown as [
      {
        data: {
          aggregateId: string;
          eventType: string;
          envelope: { payload: Record<string, unknown> };
        };
      },
    ][];
    const arg = calls[0]![0];
    expect(arg.data.eventType).toBe('user.email_verified');
    expect(arg.data.aggregateId).toBe(userId);
    expect(arg.data.envelope.payload).toMatchObject({ userId, email: NORM });
    expect(arg.data.envelope.payload.verifiedAt).toEqual(expect.any(String));
  });
});

describe('EmailAuthService.login', () => {
  async function registerAndVerify(svc: EmailAuthService, prisma: ReturnType<typeof makePrisma>) {
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    prisma.method0().emailVerified = true;
  }

  it('correo sin verificar → 403 ForbiddenError', async () => {
    const { svc } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    await expect(svc.login(EMAIL, STRONG_PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('password incorrecta → 401 UnauthorizedError', async () => {
    const { svc, prisma } = build();
    await registerAndVerify(svc, prisma);
    await expect(svc.login(EMAIL, 'WrongPassword!!')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('correo inexistente → 401 genérico', async () => {
    const { svc } = build();
    await expect(svc.login('nope@veo.pe', STRONG_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('verificado + password ok → emite tokens', async () => {
    const { svc, prisma } = build();
    await registerAndVerify(svc, prisma);
    const out = await svc.login(EMAIL, STRONG_PASSWORD);
    expect(out.accessToken).toBe('access-token');
    expect(out.user.email).toBe(NORM);
  });
});

describe('EmailAuthService.login · lockout anti brute-force', () => {
  async function registerAndVerify(svc: EmailAuthService, prisma: ReturnType<typeof makePrisma>) {
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    prisma.method0().emailVerified = true;
  }

  it('5 fallos → el 6º intento se rechaza con RateLimitError (429), aun con password correcta', async () => {
    const { svc, prisma, redis } = build();
    await registerAndVerify(svc, prisma);

    // 5 fallos consecutivos: cada uno devuelve 401.
    for (let i = 0; i < 5; i++) {
      await expect(svc.login(EMAIL, 'WrongPassword!!')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    // Tras el 5º fallo, el lock quedó seteado.
    expect(redis._store.get(`veo:login-lock:${NORM}`)).toBeDefined();

    // El 6º intento — incluso con la password CORRECTA — se bloquea (429) ANTES de comparar.
    await expect(svc.login(EMAIL, STRONG_PASSWORD)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('bloqueado rechaza ANTES de tocar la DB / comparar la contraseña', async () => {
    const { svc, prisma, redis } = build();
    await registerAndVerify(svc, prisma);
    redis._store.set(`veo:login-lock:${NORM}`, '1');
    prisma._state.methods[0]!.passwordHash = 'tampered'; // si comparara, argon2 reventaría
    await expect(svc.login(EMAIL, STRONG_PASSWORD)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('un login exitoso resetea el contador y el lock', async () => {
    const { svc, prisma, redis } = build();
    await registerAndVerify(svc, prisma);

    // 3 fallos (debajo del tope) → contador en 3, sin lock todavía.
    for (let i = 0; i < 3; i++) {
      await expect(svc.login(EMAIL, 'WrongPassword!!')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(redis._store.get(`veo:login-attempts:${NORM}`)).toBe('3');

    // Login correcto → limpia contador + lock.
    await svc.login(EMAIL, STRONG_PASSWORD);
    expect(redis._store.get(`veo:login-attempts:${NORM}`)).toBeUndefined();
    expect(redis._store.get(`veo:login-lock:${NORM}`)).toBeUndefined();
  });
});

describe('EmailAuthService.register · account-linking (correo ya verificado en otro método)', () => {
  it('vincula la credencial EMAIL_PASSWORD al User existente, sin duplicar User', async () => {
    const { svc, prisma, codes } = build();

    // Simulamos un User preexistente con un AuthMethod VERIFICADO de otro tipo (ej. Google) y ese email.
    const existingUser = await prisma.write.user.create({
      data: { email: NORM, name: 'Ada', type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: existingUser.id,
        type: 'GOOGLE',
        email: NORM,
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;

    const out = await svc.register(EMAIL, STRONG_PASSWORD, 'Ada', 'PASSENGER');
    expect(out).toEqual({ sent: true });

    // NO se creó un User nuevo: la credencial nueva cuelga del User existente.
    expect(prisma._state.users.length).toBe(usersBefore);
    const emailPwd = prisma._state.methods.find((m) => m.type === 'EMAIL_PASSWORD');
    expect(emailPwd).toBeDefined();
    expect(emailPwd!.userId).toBe(existingUser.id);
    // Y se envió el código de verificación (la nueva credencial empieza sin verificar).
    expect(codes.issue).toHaveBeenCalledWith('email-verify', NORM);
  });

  it('correo nuevo (sin método verificado previo) → crea User nuevo como siempre', async () => {
    const { svc, prisma } = build();
    await svc.register('fresh@veo.pe', STRONG_PASSWORD, 'Eve', 'PASSENGER');
    expect(prisma._state.users).toHaveLength(1);
    expect(prisma._state.methods).toHaveLength(1);
    expect(prisma._state.methods[0]!.type).toBe('EMAIL_PASSWORD');
  });
});

describe('EmailAuthService.forgotPassword (anti-enumeración)', () => {
  it('correo inexistente → {sent:true} sin enviar correo', async () => {
    const { svc, email } = build();
    const out = await svc.forgotPassword('ghost@veo.pe');
    expect(out).toEqual({ sent: true });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('correo existente → {sent:true} y envía el código de reset', async () => {
    const { svc, prisma, email, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    email.send.mockClear();
    codes.issue.mockClear();
    const out = await svc.forgotPassword(EMAIL);
    expect(out).toEqual({ sent: true });
    expect(codes.issue).toHaveBeenCalledWith('pwd-reset', NORM, { silent: true });
    expect(email.send).toHaveBeenCalledOnce();
    void prisma;
  });
});

describe('EmailAuthService.resetPassword', () => {
  it('código ok → cambia el hash y revoca TODAS las sesiones', async () => {
    const { svc, prisma, sessions } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    const oldHash = prisma.method0().passwordHash;

    const out = await svc.resetPassword(EMAIL, '123456', 'BrandNewPass!42');
    expect(out).toEqual({ ok: true });
    const newHash = prisma.method0().passwordHash!;
    expect(newHash).not.toBe(oldHash);
    expect(await argon2.verify(newHash, 'BrandNewPass!42')).toBe(true);
    expect(sessions.revokeAllForUser).toHaveBeenCalledOnce();
  });

  it('código inválido → propaga UnauthorizedError y no revoca sesiones', async () => {
    const { svc, prisma, sessions, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    codes.verify.mockRejectedValueOnce(new UnauthorizedError('Código incorrecto'));
    await expect(svc.resetPassword(EMAIL, '000000', 'BrandNewPass!42')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    void prisma;
  });

  it('rechaza newPassword débil con ValidationError antes de tocar el código', async () => {
    const { svc, codes } = build();
    await svc.register(EMAIL, STRONG_PASSWORD, undefined, 'PASSENGER');
    codes.verify.mockClear();
    await expect(svc.resetPassword(EMAIL, '123456', 'short')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(codes.verify).not.toHaveBeenCalled();
  });
});
