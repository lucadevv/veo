/**
 * ReferralsService.ensureCode — generación PEREZOSA del referralCode con retry ACOTADO ante colisión del
 * UNIQUE. Cubre los 3 caminos del intento (asigna / carrera-ya-fijado / colisión-sin-código → reintenta) y
 * que un código ya existente se devuelve sin tocar la DB. Prisma mockeado (lógica pura del retry, sin DB).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ReferralsService } from './referrals.service';
import type { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

/** Error de violación de UNIQUE que `isUniqueViolation(err, 'referralCode')` reconoce (P2002 estructural). */
function uniqueViolation(): Error {
  const err = new Error('Unique constraint failed') as Error & { code: string; meta: { target: string[] } };
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2002';
  err.meta = { target: ['referral_code'] };
  return err;
}

const config = { getOrThrow: () => 1500 } as unknown as ConfigService<Env, true>;

function buildService(prisma: {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}): ReferralsService {
  const prismaService = {
    read: { user: { findUnique: prisma.findUnique } },
    write: { user: { update: prisma.update } },
  } as unknown as PrismaService;
  return new ReferralsService(prismaService, config);
}

describe('ReferralsService.ensureCode', () => {
  it('devuelve el código existente SIN tocar la DB de escritura', async () => {
    const findUnique = vi.fn().mockResolvedValue({ referralCode: 'ABC123', deletedAt: null });
    const update = vi.fn();
    const svc = buildService({ findUnique, update });

    await expect(svc.ensureCode('u1')).resolves.toBe('ABC123');
    expect(update).not.toHaveBeenCalled();
  });

  it('sin código: GENERA y asigna uno nuevo (update OK → devuelve el candidato)', async () => {
    const findUnique = vi.fn().mockResolvedValueOnce({ referralCode: null, deletedAt: null });
    const update = vi.fn().mockResolvedValue({ id: 'u1' });
    const svc = buildService({ findUnique, update });

    const code = await svc.ensureCode('u1');
    expect(code).toMatch(/.+/); // un código generado, no vacío
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('colisión con carrera: el update choca UNIQUE y otro proceso ya fijó el código → devuelve ESE', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ referralCode: null, deletedAt: null }) // entrada de ensureCode
      .mockResolvedValueOnce({ referralCode: 'RACE99' }); // relectura tras la colisión (carrera)
    const update = vi.fn().mockRejectedValue(uniqueViolation());
    const svc = buildService({ findUnique, update });

    await expect(svc.ensureCode('u1')).resolves.toBe('RACE99');
  });

  it('colisión sin carrera: choca UNIQUE, no hay código fresco → REINTENTA y el 2º intento asigna', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ referralCode: null, deletedAt: null }) // entrada
      .mockResolvedValueOnce({ referralCode: null }); // relectura tras la 1ª colisión: nadie lo fijó
    const update = vi
      .fn()
      .mockRejectedValueOnce(uniqueViolation()) // 1er intento choca
      .mockResolvedValueOnce({ id: 'u1' }); // 2º intento asigna
    const svc = buildService({ findUnique, update });

    const code = await svc.ensureCode('u1');
    expect(code).toMatch(/.+/);
    expect(update).toHaveBeenCalledTimes(2); // reintentó una vez
  });

  it('usuario inexistente o borrado → NotFoundError', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const svc = buildService({ findUnique, update: vi.fn() });
    await expect(svc.ensureCode('u1')).rejects.toThrow();
  });
});
