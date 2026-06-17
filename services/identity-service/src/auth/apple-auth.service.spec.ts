import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { AppleAuthService } from './apple-auth.service';
import { OAuthLoginService } from './oauth-login.service';
import type { AppleIdentity, GoogleIdentity, OAuthVerifier } from '../ports/oauth/oauth.port';

/**
 * Doble de Prisma en memoria: modela `user` + `authMethod` + `outboxEvent` lo justo para
 * loginWithApple (re-login por sub, account-linking por email verificado, alta nueva). Soporta
 * findUnique por compuesto (type_oauthSubject) y por id, findFirst (email+emailVerified), create.
 * Espejo del doble de google-auth.service.spec.ts.
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
  oauthSubject: string | null;
  emailVerified: boolean;
  verified: boolean;
}

function makePrisma() {
  const users: UserRow[] = [];
  const methods: MethodRow[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const authMethod = {
    findUnique: vi.fn(
      async ({
        where,
        include,
      }: {
        where: Record<string, unknown>;
        include?: { user?: boolean };
      }) => {
        let m: MethodRow | undefined;
        if (where.type_oauthSubject) {
          const { type, oauthSubject } = where.type_oauthSubject as {
            type: string;
            oauthSubject: string;
          };
          m = methods.find((x) => x.type === type && x.oauthSubject === oauthSubject);
        } else if (where.id) {
          m = methods.find((x) => x.id === where.id);
        }
        if (!m) return null;
        const found = m;
        if (include?.user) return { ...found, user: users.find((u) => u.id === found.userId)! };
        return { ...found };
      },
    ),
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
        // Emulamos los constraints reales del schema (@@unique([type,email]) y
        // @@unique([type,oauthSubject])): si chocan, lanzamos P2002 como lo haría Prisma.
        const email = data.email ?? null;
        const oauthSubject = data.oauthSubject ?? null;
        if (email !== null && methods.some((x) => x.type === data.type && x.email === email)) {
          const err = new Error('Unique constraint failed') as Error & {
            code: string;
            meta: { target: string[] };
          };
          err.code = 'P2002';
          err.meta = { target: ['type', 'email'] };
          throw err;
        }
        if (
          oauthSubject !== null &&
          methods.some((x) => x.type === data.type && x.oauthSubject === oauthSubject)
        ) {
          const err = new Error('Unique constraint failed') as Error & {
            code: string;
            meta: { target: string[] };
          };
          err.code = 'P2002';
          err.meta = { target: ['type', 'oauth_subject'] };
          throw err;
        }
        const row: MethodRow = {
          id: nextId('am'),
          userId: data.userId,
          type: data.type,
          email,
          oauthSubject,
          emailVerified: data.emailVerified ?? false,
          verified: data.verified ?? false,
        };
        methods.push(row);
        return { ...row };
      },
    ),
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
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const u = users.find((x) => x.id === where.id);
      return u ? { ...u } : null;
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
  };
}

/** Verificador OAuth doble: devuelve la identidad Apple que le inyectemos, o lanza 401. */
function makeVerifier(identity: AppleIdentity | UnauthorizedError): OAuthVerifier {
  return {
    verifyGoogleIdToken: vi.fn(
      async (): Promise<GoogleIdentity> => ({
        sub: 'unused',
        email: null,
        emailVerified: false,
        name: null,
      }),
    ),
    verifyAppleIdToken: vi.fn(async () => {
      if (identity instanceof UnauthorizedError) throw identity;
      return identity;
    }),
  };
}

/** TokenIssuerService doble: emite el par fijo que esperan las aserciones. */
function makeTokenIssuer() {
  return {
    issue: vi.fn(
      async (userId: string, _typ: string, user: { id: string; email?: string | null }) => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user,
        _userId: userId,
      }),
    ),
  };
}

function build(identity: AppleIdentity | UnauthorizedError) {
  const prisma = makePrisma();
  const verifier = makeVerifier(identity);
  const tokenIssuer = makeTokenIssuer();
  // Flujo OAuth compartido REAL (Lote A2): los dobles quedan solo en los bordes (prisma/verifier/issuer).
  const oauthLogin = new OAuthLoginService(prisma as never, tokenIssuer as never);
  const svc = new AppleAuthService(verifier, oauthLogin);
  return { svc, prisma, verifier, tokenIssuer };
}

const TOKEN = 'fixture-identity-token';

describe('AppleAuthService.loginWithApple', () => {
  it('usuario nuevo (sin vínculo Apple ni email previo) → crea User PASSENGER + AuthMethod{APPLE_OAUTH} + outbox', async () => {
    const { svc, prisma, tokenIssuer } = build({
      sub: 'a-sub-1',
      email: 'New@privaterelay.appleid.com',
      emailVerified: true,
      name: null,
    });

    const out = await svc.loginWithApple(TOKEN);

    expect(out.accessToken).toBe('access-token');
    expect(prisma._state.users).toHaveLength(1);
    const u = prisma._state.users[0]!;
    expect(u.type).toBe('PASSENGER');
    expect(u.email).toBe('new@privaterelay.appleid.com'); // normalizado a minúsculas
    expect(u.name).toBeNull(); // Apple no manda el nombre en el token
    const m = prisma._state.methods[0]!;
    expect(m.type).toBe('APPLE_OAUTH');
    expect(m.oauthSubject).toBe('a-sub-1');
    expect(m.emailVerified).toBe(true);
    expect(m.verified).toBe(true);
    expect(prisma.write.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tokenIssuer.issue).toHaveBeenCalledWith(
      u.id,
      'passenger',
      expect.objectContaining({ id: u.id, email: 'new@privaterelay.appleid.com' }),
    );
  });

  it('vincula por email VERIFICADO a un User existente (otro método) sin duplicar User ni outbox', async () => {
    const { svc, prisma, tokenIssuer } = build({
      sub: 'a-sub-link',
      email: 'ada@veo.pe',
      emailVerified: true,
      name: null,
    });

    // User preexistente con un método EMAIL_PASSWORD verificado con ese correo.
    const existing = await prisma.write.user.create({
      data: { email: 'ada@veo.pe', name: 'Ada', type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: existing.id,
        type: 'EMAIL_PASSWORD',
        email: 'ada@veo.pe',
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;
    prisma.write.outboxEvent.create.mockClear();

    const out = await svc.loginWithApple(TOKEN);
    expect(out.accessToken).toBe('access-token');

    // No se creó un User nuevo: la credencial Apple cuelga del User existente.
    expect(prisma._state.users.length).toBe(usersBefore);
    const appleMethod = prisma._state.methods.find((m) => m.type === 'APPLE_OAUTH');
    expect(appleMethod).toBeDefined();
    expect(appleMethod!.userId).toBe(existing.id);
    expect(appleMethod!.oauthSubject).toBe('a-sub-link');
    // Linking, no alta nueva → NO se emite user.registered.
    expect(prisma.write.outboxEvent.create).not.toHaveBeenCalled();
    expect(tokenIssuer.issue).toHaveBeenCalledWith(existing.id, 'passenger', expect.anything());
  });

  it('vínculo Apple existente (mismo sub) → re-login idempotente SIN EMAIL (Apple no lo manda), no crea User ni método nuevo', async () => {
    // Login posterior: Apple no manda email (email=null), pero el sub estable resuelve el User.
    const { svc, prisma } = build({
      sub: 'a-sub-existing',
      email: null,
      emailVerified: false,
      name: null,
    });

    const existing = await prisma.write.user.create({
      data: { email: 'bob@privaterelay.appleid.com', name: null, type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: existing.id,
        type: 'APPLE_OAUTH',
        oauthSubject: 'a-sub-existing',
        email: 'bob@privaterelay.appleid.com',
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;
    const methodsBefore = prisma._state.methods.length;

    const out = await svc.loginWithApple(TOKEN);
    expect(out.accessToken).toBe('access-token');
    expect(prisma._state.users.length).toBe(usersBefore);
    expect(prisma._state.methods.length).toBe(methodsBefore); // no se duplica el AuthMethod
  });

  it('email NO verificado por Apple → NO vincula con cuenta ajena; crea identidad Apple propia con email=null', async () => {
    const { svc, prisma } = build({
      sub: 'a-sub-unverified',
      email: 'ada@veo.pe',
      emailVerified: false,
      name: null,
    });

    // Existe un User con ese correo verificado por OTRO método.
    const victim = await prisma.write.user.create({
      data: { email: 'ada@veo.pe', name: 'Ada', type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: victim.id,
        type: 'EMAIL_PASSWORD',
        email: 'ada@veo.pe',
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;

    await svc.loginWithApple(TOKEN);

    // No se secuestra la cuenta de la víctima: se crea un User nuevo para la identidad Apple.
    expect(prisma._state.users.length).toBe(usersBefore + 1);
    const appleMethod = prisma._state.methods.find((m) => m.type === 'APPLE_OAUTH');
    expect(appleMethod!.userId).not.toBe(victim.id);
    expect(appleMethod!.emailVerified).toBe(false);
    // El correo NO verificado NO se persiste en la credencial (evita choque @@unique([type,email])).
    expect(appleMethod!.email).toBeNull();
  });

  it('token de Apple inválido → propaga UnauthorizedError y no toca la DB', async () => {
    const { svc, prisma } = build(new UnauthorizedError('token de Apple inválido'));
    await expect(svc.loginWithApple(TOKEN)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prisma._state.users).toHaveLength(0);
    expect(prisma._state.methods).toHaveLength(0);
  });
});
