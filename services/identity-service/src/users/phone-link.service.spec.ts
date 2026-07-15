/**
 * PhoneLinkService — vincular teléfono al perfil reusando la infra OTP del login (ADR-012).
 * Cubre: request (formato inválido, número ajeno → 409 PHONE_TAKEN, rate-limit del OTP);
 * verify (código ok setea phone + upsert AuthMethod{PHONE_OTP}, código malo, lockout, reemplazo
 * de teléfono previo, número ajeno en re-chequeo de tx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, RateLimitError, UnauthorizedError, ValidationError } from '@veo/utils';
import { PhoneLinkService } from './phone-link.service';
import { PhoneLinkRepository } from './phone-link.repository';
import { PhoneTakenError } from './phone-link.errors';

/**
 * Prisma mock: `read.user.findUnique` resuelve el dueño por phone (para PHONE_TAKEN), `write` corre
 * la tx con user.update + authMethod.upsert. `ownerByPhone` mapea phone→userId (dueño actual).
 */
function makePrisma(ownerByPhone: Record<string, string> = {}) {
  const authMethod = { upsert: vi.fn(async () => ({})) };
  const userUpdate = vi.fn(async () => ({}));
  const findOwner = vi.fn(async ({ where }: { where: { phone: string } }) => {
    const id = ownerByPhone[where.phone];
    return id ? { id, phone: where.phone, type: 'PASSENGER', kycStatus: 'PENDING' } : null;
  });
  const tx = { user: { findUnique: findOwner, update: userUpdate }, authMethod };
  const write = {
    ...tx,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const read = { user: { findUnique: findOwner } };
  return { write, read, _m: { authMethod, userUpdate, findOwner } };
}

const PROFILE = {
  id: 'u-1',
  phone: '+51987654321',
  email: 'me@veo.pe',
  name: null,
  type: 'PASSENGER',
  kycStatus: 'PENDING',
  photoUrl: null,
  documentType: null,
  document: null,
  deletionRequestedAt: null,
};

function makeUsers() {
  return { getProfile: vi.fn(async () => PROFILE) };
}

describe('PhoneLinkService.request', () => {
  let otp: { issue: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    otp = { issue: vi.fn(async () => '123456'), verify: vi.fn(async () => undefined) };
  });

  it('formato inválido → ValidationError (no toca OTP)', async () => {
    const prisma = makePrisma();
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, makeUsers() as never);
    await expect(svc.request('u-1', '12345')).rejects.toBeInstanceOf(ValidationError);
    expect(otp.issue).not.toHaveBeenCalled();
  });

  it('número de OTRO usuario → 409 PHONE_TAKEN (no emite OTP)', async () => {
    // El +51987654321 ya pertenece a u-2.
    const prisma = makePrisma({ '+51987654321': 'u-2' });
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, makeUsers() as never);
    await expect(svc.request('u-1', '987654321')).rejects.toBeInstanceOf(PhoneTakenError);
    expect(otp.issue).not.toHaveBeenCalled();
  });

  it('número propio o libre → emite OTP y responde {sent:true}', async () => {
    const prisma = makePrisma(); // libre
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, makeUsers() as never);
    const res = await svc.request('u-1', '987654321');
    expect(res).toEqual({ sent: true });
    expect(otp.issue).toHaveBeenCalledWith('+51987654321');
  });

  it('rate-limit del OTP (cooldown) → propaga RateLimitError', async () => {
    const prisma = makePrisma();
    otp.issue = vi.fn(async () => {
      throw new RateLimitError('Espera unos segundos antes de pedir otro código');
    });
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, makeUsers() as never);
    await expect(svc.request('u-1', '987654321')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('PhoneLinkService.verify', () => {
  let otp: { issue: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let users: ReturnType<typeof makeUsers>;
  beforeEach(() => {
    otp = { issue: vi.fn(async () => '123456'), verify: vi.fn(async () => undefined) };
    users = makeUsers();
  });

  it('código OK: setea User.phone + upsert AuthMethod{PHONE_OTP} y devuelve el perfil', async () => {
    const prisma = makePrisma(); // número libre
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, users as never);

    const out = await svc.verify('u-1', '987654321', '123456');

    expect(otp.verify).toHaveBeenCalledWith('+51987654321', '123456');
    expect(prisma._m.userUpdate).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { phone: '+51987654321' },
    });
    expect(prisma._m.authMethod.upsert).toHaveBeenCalledWith({
      where: { userId_type: { userId: 'u-1', type: 'PHONE_OTP' } },
      create: { userId: 'u-1', type: 'PHONE_OTP', verified: true },
      update: { verified: true },
    });
    expect(users.getProfile).toHaveBeenCalledWith('u-1');
    expect(out).toEqual(PROFILE);
  });

  it('código malo → UnauthorizedError (no toca DB)', async () => {
    const prisma = makePrisma();
    otp.verify = vi.fn(async () => {
      throw new UnauthorizedError('Código incorrecto');
    });
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, users as never);

    await expect(svc.verify('u-1', '987654321', '000000')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(prisma._m.userUpdate).not.toHaveBeenCalled();
    expect(prisma._m.authMethod.upsert).not.toHaveBeenCalled();
  });

  it('lockout (demasiados intentos) → ConflictError, sin tocar DB', async () => {
    const prisma = makePrisma();
    otp.verify = vi.fn(async () => {
      throw new ConflictError('Demasiados intentos. Solicita un nuevo código.');
    });
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, users as never);

    await expect(svc.verify('u-1', '987654321', '123456')).rejects.toBeInstanceOf(ConflictError);
    expect(prisma._m.userUpdate).not.toHaveBeenCalled();
  });

  it('REEMPLAZO: el usuario ya tenía otro teléfono → upsert idempotente (update verified)', async () => {
    // u-1 ya es dueño de su nuevo número (caso re-vincular el mismo) y pide vincular +51999888777.
    const prisma = makePrisma();
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, users as never);

    await svc.verify('u-1', '999888777', '123456');

    expect(prisma._m.userUpdate).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { phone: '+51999888777' },
    });
    // upsert con update no-vacío → idempotente aunque el método ya exista (no recrea).
    expect(prisma._m.authMethod.upsert).toHaveBeenCalledWith({
      where: { userId_type: { userId: 'u-1', type: 'PHONE_OTP' } },
      create: { userId: 'u-1', type: 'PHONE_OTP', verified: true },
      update: { verified: true },
    });
  });

  it('número tomado por otro entre request y verify (re-chequeo en tx) → 409 PHONE_TAKEN', async () => {
    // El número quedó a nombre de u-2 (carrera). El re-chequeo dentro de la tx lo detecta.
    const prisma = makePrisma({ '+51987654321': 'u-2' });
    const svc = new PhoneLinkService(new PhoneLinkRepository(prisma as never), otp as never, users as never);

    await expect(svc.verify('u-1', '987654321', '123456')).rejects.toBeInstanceOf(PhoneTakenError);
    expect(prisma._m.userUpdate).not.toHaveBeenCalled();
  });
});
