import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { GoogleAuthService } from './google-auth.service';
import { OAuthLoginService } from './oauth-login.service';
import { OAuthLoginRepository } from './oauth-login.repository';
import type { AppleIdentity, GoogleIdentity, OAuthVerifier } from '../ports/oauth/oauth.port';

/**
 * Doble de Prisma en memoria: modela `user` + `authMethod` + `outboxEvent` lo justo para
 * loginWithGoogle (re-login por sub, account-linking por email verificado, alta nueva). Soporta
 * findUnique por compuesto (type_oauthSubject) y por id, findFirst (email+emailVerified), create.
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

/** Verificador OAuth doble: devuelve la identidad Google que le inyectemos, o lanza 401. */
function makeVerifier(identity: GoogleIdentity | UnauthorizedError): OAuthVerifier {
  return {
    verifyGoogleIdToken: vi.fn(async () => {
      if (identity instanceof UnauthorizedError) throw identity;
      return identity;
    }),
    verifyAppleIdToken: vi.fn(
      async (): Promise<AppleIdentity> => ({
        sub: 'unused',
        email: null,
        emailVerified: false,
        name: null,
      }),
    ),
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

function build(identity: GoogleIdentity | UnauthorizedError) {
  const prisma = makePrisma();
  const verifier = makeVerifier(identity);
  const tokenIssuer = makeTokenIssuer();
  // Flujo OAuth compartido REAL (Lote A2): los dobles quedan solo en los bordes (prisma/verifier/issuer).
  const oauthLogin = new OAuthLoginService(new OAuthLoginRepository(prisma as never), tokenIssuer as never);
  const svc = new GoogleAuthService(verifier, oauthLogin);
  return { svc, prisma, verifier, tokenIssuer };
}

const TOKEN = 'fixture-id-token';

describe('GoogleAuthService.loginWithGoogle', () => {
  it('usuario nuevo (sin vínculo Google ni email previo) → crea User PASSENGER + AuthMethod{GOOGLE_OAUTH} + outbox', async () => {
    const { svc, prisma, tokenIssuer } = build({
      sub: 'g-sub-1',
      email: 'New@Veo.PE',
      emailVerified: true,
      name: 'Newbie',
    });

    const out = await svc.loginWithGoogle(TOKEN);

    expect(out.accessToken).toBe('access-token');
    expect(prisma._state.users).toHaveLength(1);
    const u = prisma._state.users[0]!;
    expect(u.type).toBe('PASSENGER');
    expect(u.email).toBe('new@veo.pe'); // normalizado a minúsculas
    expect(u.name).toBe('Newbie');
    const m = prisma._state.methods[0]!;
    expect(m.type).toBe('GOOGLE_OAUTH');
    expect(m.oauthSubject).toBe('g-sub-1');
    expect(m.emailVerified).toBe(true);
    expect(m.verified).toBe(true);
    expect(prisma.write.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tokenIssuer.issue).toHaveBeenCalledWith(
      u.id,
      'passenger',
      expect.objectContaining({ id: u.id, email: 'new@veo.pe' }),
    );
  });

  it('vincula por email VERIFICADO a un User existente (otro método) sin duplicar User ni outbox', async () => {
    const { svc, prisma, tokenIssuer } = build({
      sub: 'g-sub-link',
      email: 'ada@veo.pe',
      emailVerified: true,
      name: 'Ada',
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

    const out = await svc.loginWithGoogle(TOKEN);
    expect(out.accessToken).toBe('access-token');

    // No se creó un User nuevo: la credencial Google cuelga del User existente.
    expect(prisma._state.users.length).toBe(usersBefore);
    const googleMethod = prisma._state.methods.find((m) => m.type === 'GOOGLE_OAUTH');
    expect(googleMethod).toBeDefined();
    expect(googleMethod!.userId).toBe(existing.id);
    expect(googleMethod!.oauthSubject).toBe('g-sub-link');
    // Linking, no alta nueva → NO se emite user.registered.
    expect(prisma.write.outboxEvent.create).not.toHaveBeenCalled();
    expect(tokenIssuer.issue).toHaveBeenCalledWith(existing.id, 'passenger', expect.anything());
  });

  it('vínculo Google existente (mismo sub) → re-login idempotente, no crea User ni método nuevo', async () => {
    const { svc, prisma } = build({
      sub: 'g-sub-existing',
      email: 'bob@veo.pe',
      emailVerified: true,
      name: 'Bob',
    });

    const existing = await prisma.write.user.create({
      data: { email: 'bob@veo.pe', name: 'Bob', type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: existing.id,
        type: 'GOOGLE_OAUTH',
        oauthSubject: 'g-sub-existing',
        email: 'bob@veo.pe',
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;
    const methodsBefore = prisma._state.methods.length;

    const out = await svc.loginWithGoogle(TOKEN);
    expect(out.accessToken).toBe('access-token');
    expect(prisma._state.users.length).toBe(usersBefore);
    expect(prisma._state.methods.length).toBe(methodsBefore); // no se duplica el AuthMethod
  });

  it('email NO verificado por Google → NO vincula con cuenta ajena; crea identidad Google propia', async () => {
    const { svc, prisma } = build({
      sub: 'g-sub-unverified',
      email: 'ada@veo.pe',
      emailVerified: false,
      name: 'Impostor',
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

    await svc.loginWithGoogle(TOKEN);

    // No se secuestra la cuenta de la víctima: se crea un User nuevo para la identidad Google.
    expect(prisma._state.users.length).toBe(usersBefore + 1);
    const googleMethod = prisma._state.methods.find((m) => m.type === 'GOOGLE_OAUTH');
    expect(googleMethod!.userId).not.toBe(victim.id);
    expect(googleMethod!.emailVerified).toBe(false);
    // El correo NO verificado NO se persiste en la credencial (evita choque @@unique([type,email])).
    expect(googleMethod!.email).toBeNull();
  });

  it('segundo Google con email NO verificado que ya existe como GOOGLE_OAUTH → crea identidad nueva con email=null, NO 500, NO hijack', async () => {
    const { svc, prisma } = build({
      sub: 'g-sub-B',
      email: 'linkme2@veo.pe',
      emailVerified: false,
      name: 'Segundo',
    });

    // Ya existe una identidad Google VERIFICADA (otro `sub`) con ese mismo correo.
    const first = await prisma.write.user.create({
      data: { email: 'linkme2@veo.pe', name: 'Primero', type: 'PASSENGER' },
    });
    await prisma.write.authMethod.create({
      data: {
        userId: first.id,
        type: 'GOOGLE_OAUTH',
        oauthSubject: 'g-sub-A',
        email: 'linkme2@veo.pe',
        emailVerified: true,
        verified: true,
      },
    });
    const usersBefore = prisma._state.users.length;
    const methodsBefore = prisma._state.methods.length;

    // Antes del fix esto lanzaba P2002 (HTTP 500) por @@unique([type, email]).
    const out = await svc.loginWithGoogle(TOKEN);
    expect(out.accessToken).toBe('access-token');

    // Se creó una identidad NUEVA (user + method), sin tocar la del primer Google.
    expect(prisma._state.users.length).toBe(usersBefore + 1);
    expect(prisma._state.methods.length).toBe(methodsBefore + 1);

    const newMethod = prisma._state.methods.find((m) => m.oauthSubject === 'g-sub-B');
    expect(newMethod).toBeDefined();
    expect(newMethod!.type).toBe('GOOGLE_OAUTH');
    expect(newMethod!.email).toBeNull(); // email NO verificado → no se persiste
    expect(newMethod!.emailVerified).toBe(false);
    expect(newMethod!.userId).not.toBe(first.id); // NO hijack: distinto User

    // La credencial del primer Google queda intacta (mismo email verificado, mismo userId).
    const firstMethod = prisma._state.methods.find((m) => m.oauthSubject === 'g-sub-A');
    expect(firstMethod!.userId).toBe(first.id);
    expect(firstMethod!.email).toBe('linkme2@veo.pe');
    expect(firstMethod!.emailVerified).toBe(true);
  });

  it('token de Google inválido → propaga UnauthorizedError y no toca la DB', async () => {
    const { svc, prisma } = build(new UnauthorizedError('token de Google inválido'));
    await expect(svc.loginWithGoogle(TOKEN)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prisma._state.users).toHaveLength(0);
    expect(prisma._state.methods).toHaveLength(0);
  });
});
