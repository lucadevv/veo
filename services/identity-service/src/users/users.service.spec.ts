/**
 * Unit de UsersService · documento del pasajero en el PERFIL (Yape On File de UN TAP).
 * Verifica: GET devuelve documentType+document; PATCH persiste el documento; el AUDIT log del cambio
 * de documento sale MASCARADO (nunca el valor completo) y SOLO cuando el documento cambia.
 * Sin DB real (doble de Prisma read/write).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ DELETION_GRACE_DAYS: 30 });

interface UserRow {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  type: string;
  kycStatus: string;
  photoUrl: string | null;
  documentType: 'DN' | 'CE' | 'PP' | null;
  document: string | null;
  deletedAt: Date | null;
  deletionRequestedAt: Date | null;
}

function baseUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u1',
    phone: '999888777',
    email: null,
    name: 'Juan Perez',
    type: 'PASSENGER',
    kycStatus: 'VERIFIED',
    photoUrl: null,
    documentType: null,
    document: null,
    deletedAt: null,
    deletionRequestedAt: null,
    ...overrides,
  };
}

function makePrisma(current: UserRow) {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...current,
    ...args.data,
  }));
  const prisma = {
    read: { user: { findUnique: vi.fn(async () => current) } },
    write: { user: { update } },
  };
  return { prisma, update };
}

describe('UsersService.getProfile · devuelve el documento', () => {
  it('expone documentType + document completos (es SU dato, owner-only por JWT)', async () => {
    const { prisma } = makePrisma(baseUser({ documentType: 'DN', document: '12345678' }));
    const svc = new UsersService(prisma as never, config);
    const view = await svc.getProfile('u1');
    expect(view.documentType).toBe('DN');
    expect(view.document).toBe('12345678');
  });

  it('documentType/document null si el usuario aún no lo cargó', async () => {
    const { prisma } = makePrisma(baseUser());
    const svc = new UsersService(prisma as never, config);
    const view = await svc.getProfile('u1');
    expect(view.documentType).toBeNull();
    expect(view.document).toBeNull();
  });
});

describe('UsersService.updateProfile · persiste el documento', () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('persiste documentType + document en el perfil', async () => {
    const { prisma, update } = makePrisma(baseUser());
    const svc = new UsersService(prisma as never, config);
    const view = await svc.updateProfile('u1', { documentType: 'DN', document: '12345678' });

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.documentType).toBe('DN');
    expect(data.document).toBe('12345678');
    expect(view.document).toBe('12345678');
  });

  it('AUDIT log del cambio sale MASCARADO (nunca el documento completo)', async () => {
    const { prisma } = makePrisma(baseUser());
    const svc = new UsersService(prisma as never, config);
    await svc.updateProfile('u1', { documentType: 'DN', document: '12345678' });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const msg = auditSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('profile.document_changed');
    expect(msg).toContain('******78'); // mascarado
    expect(msg).not.toContain('12345678'); // jamás el valor completo
  });

  it('NO audita cuando el documento no cambia (solo se actualiza el nombre)', async () => {
    const { prisma } = makePrisma(baseUser({ documentType: 'DN', document: '12345678' }));
    const svc = new UsersService(prisma as never, config);
    await svc.updateProfile('u1', { name: 'Otro Nombre' });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('preserva el documento existente si el PATCH no lo toca', async () => {
    const { prisma, update } = makePrisma(baseUser({ documentType: 'CE', document: '123456789' }));
    const svc = new UsersService(prisma as never, config);
    await svc.updateProfile('u1', { name: 'Nuevo' });
    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.documentType).toBe('CE');
    expect(data.document).toBe('123456789');
  });
});
