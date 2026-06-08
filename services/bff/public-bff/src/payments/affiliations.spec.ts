/**
 * Proxy de afiliación Yape On File (L2 · UN TAP, documento en PERFIL). Cubre:
 *  - UN TAP: con perfil completo (document+name) afilia SIN body, leyendo todo del perfil.
 *  - Body con {documentType, document} → guarda PRIMERO en el perfil (PATCH a identity) Y LUEGO afilia;
 *    si la afiliación falla, el documento IGUAL quedó guardado (orden verificado).
 *  - 422 con code DISTINGUIBLE: PROFILE_NAME_MISSING (falta nombre) vs PROFILE_DOCUMENT_MISSING (falta doc).
 *  - Delegación FIRMADA al payment-service con identity=user (anti-IDOR), origin=MOBILE y SIN phone.
 *  - Validación class-validator del body opcional ({documentType?, document?}).
 *  - Shapes del contrato (passthrough de deepLink/phoneMasked, status:'NONE').
 */
import { describe, it, expect, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AuthenticatedUser } from '@veo/auth';
import type { InternalRestClient } from '@veo/rpc';
import { AffiliationsService } from './affiliations.service';
import {
  CreateYapeAffiliationDto,
  ProfileDocumentMissingError,
  ProfileNameMissingError,
} from './dto/affiliations.dto';

const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function errorsOf(payload: unknown): string[] {
  const dto = plainToInstance(CreateYapeAffiliationDto, payload);
  return validateSync(dto as object, { whitelist: true }).flatMap((e) =>
    Object.keys(e.constraints ?? {}),
  );
}

/** Perfil base devuelto por identity (GET y PATCH). */
function profile(opts: { name?: string | null; documentType?: 'DN' | 'CE' | 'PP' | null; document?: string | null }) {
  return {
    id: 'usr-1',
    phone: '999',
    type: 'passenger',
    kycStatus: 'VERIFIED',
    name: opts.name ?? null,
    email: null,
    photoUrl: null,
    documentType: opts.documentType ?? null,
    document: opts.document ?? null,
  };
}

function makeService(opts: {
  profileName?: string | null;
  profileDocumentType?: 'DN' | 'CE' | 'PP' | null;
  profileDocument?: string | null;
  /** Lo que devuelve el PATCH a identity (perfil tras guardar el documento). Default = el GET. */
  patchReturn?: unknown;
  paymentReturn?: unknown;
  paymentThrows?: Error;
}) {
  const getProfile = profile({ name: opts.profileName, documentType: opts.profileDocumentType, document: opts.profileDocument });
  const post = opts.paymentThrows
    ? vi.fn().mockRejectedValue(opts.paymentThrows)
    : vi.fn().mockResolvedValue(opts.paymentReturn ?? { affiliationId: 'aff-1', status: 'PROCESS', deepLink: 'yape://approve/abc' });
  const payment = {
    post,
    get: vi.fn().mockResolvedValue(opts.paymentReturn ?? { status: 'NONE' }),
    delete: vi.fn().mockResolvedValue(opts.paymentReturn ?? { affiliationId: 'aff-1', status: 'REVOKED' }),
  } as unknown as InternalRestClient & { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  const identity = {
    get: vi.fn().mockResolvedValue(getProfile),
    patch: vi.fn().mockResolvedValue(opts.patchReturn ?? getProfile),
  } as unknown as InternalRestClient & { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
  const svc = new AffiliationsService(payment, identity);
  return { svc, payment, identity };
}

describe('AffiliationsService (UN TAP · documento en perfil)', () => {
  it('UN TAP: con document+name en el perfil afilia SIN body, leyendo todo del perfil', async () => {
    const { svc, payment, identity } = makeService({ profileName: 'Juan Perez', profileDocumentType: 'DN', profileDocument: '12345678' });
    const view = await svc.create(user, {});
    expect(view.status).toBe('PROCESS');
    expect(view.deepLink).toBe('yape://approve/abc');
    expect(view).not.toHaveProperty('walletUid');

    expect(identity.get).toHaveBeenCalledWith('/users/me', { identity: user });
    expect(identity.patch).not.toHaveBeenCalled(); // sin body, no guarda nada
    expect(payment.post).toHaveBeenCalledWith(
      '/affiliations/yape',
      expect.objectContaining({
        identity: user,
        body: { document: '12345678', documentType: 'DN', clientName: 'Juan Perez', origin: 'MOBILE' },
      }),
    );
    const sent = payment.post.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty('userId');
    expect(sent).not.toHaveProperty('phone'); // UN TAP: no se pide teléfono
  });

  it('body con {documentType, document} → GUARDA primero en el perfil (PATCH) Y LUEGO afilia', async () => {
    const { svc, payment, identity } = makeService({
      profileName: 'Juan Perez',
      // perfil ARRANCA sin documento; el PATCH lo persiste y devuelve el perfil ya con documento.
      profileDocument: null,
      patchReturn: profile({ name: 'Juan Perez', documentType: 'DN', document: '12345678' }),
    });
    const view = await svc.create(user, { documentType: 'DN', document: '12345678' });
    expect(view.status).toBe('PROCESS');

    // Guarda PRIMERO el documento en identity.
    expect(identity.patch).toHaveBeenCalledWith('/users/me', {
      identity: user,
      body: { documentType: 'DN', document: '12345678' },
    });
    // Y LUEGO afilia con el documento del perfil.
    expect(payment.post).toHaveBeenCalledWith(
      '/affiliations/yape',
      expect.objectContaining({
        body: { document: '12345678', documentType: 'DN', clientName: 'Juan Perez', origin: 'MOBILE' },
      }),
    );
    // Orden: PATCH antes que POST.
    expect(identity.patch.mock.invocationCallOrder[0]!).toBeLessThan(payment.post.mock.invocationCallOrder[0]!);
  });

  it('si la afiliación FALLA, el documento IGUAL quedó guardado (guardar primero es correcto)', async () => {
    const { svc, identity } = makeService({
      profileName: 'Juan Perez',
      profileDocument: null,
      patchReturn: profile({ name: 'Juan Perez', documentType: 'DN', document: '12345678' }),
      paymentThrows: new Error('proveedor caído'),
    });
    await expect(svc.create(user, { documentType: 'DN', document: '12345678' })).rejects.toThrow('proveedor caído');
    // El PATCH se ejecutó ANTES del fallo → el documento ya está persistido.
    expect(identity.patch).toHaveBeenCalledTimes(1);
  });

  it('sin body y perfil SIN documento → 422 PROFILE_DOCUMENT_MISSING (code distinguible)', async () => {
    const { svc, payment } = makeService({ profileName: 'Juan Perez', profileDocument: null });
    await expect(svc.create(user, {})).rejects.toBeInstanceOf(ProfileDocumentMissingError);
    await expect(svc.create(user, {})).rejects.toMatchObject({ code: 'PROFILE_DOCUMENT_MISSING', httpStatus: 422 });
    expect(payment.post).not.toHaveBeenCalled();
  });

  it('perfil SIN nombre → 422 PROFILE_NAME_MISSING (code distinto, no delega)', async () => {
    const { svc, payment } = makeService({ profileName: null, profileDocumentType: 'DN', profileDocument: '12345678' });
    await expect(svc.create(user, {})).rejects.toBeInstanceOf(ProfileNameMissingError);
    await expect(svc.create(user, {})).rejects.toMatchObject({ code: 'PROFILE_NAME_MISSING', httpStatus: 422 });
    expect(payment.post).not.toHaveBeenCalled();
  });

  it('nombre solo en blanco → 422 PROFILE_NAME_MISSING (trim)', async () => {
    const { svc } = makeService({ profileName: '   ', profileDocumentType: 'DN', profileDocument: '12345678' });
    await expect(svc.create(user, {})).rejects.toBeInstanceOf(ProfileNameMissingError);
  });

  it('GET delega firmado y propaga status:NONE / phoneMasked tal cual', async () => {
    const { svc, payment } = makeService({ paymentReturn: { status: 'NONE' } });
    const none = await svc.status(user);
    expect(none).toEqual({ status: 'NONE' });
    expect(payment.get).toHaveBeenCalledWith('/affiliations/yape', { identity: user });

    const { svc: svc2 } = makeService({ paymentReturn: { affiliationId: 'aff-1', status: 'ACTIVE', wallet: 'YAPE', phoneMasked: '9****4321' } });
    const active = await svc2.status(user);
    expect(active.phoneMasked).toBe('9****4321');
    expect(active).not.toHaveProperty('walletUid');
  });

  it('DELETE delega firmado y devuelve status REVOKED', async () => {
    const { svc, payment } = makeService({ paymentReturn: { affiliationId: 'aff-1', status: 'REVOKED', wallet: 'YAPE' } });
    const view = await svc.revoke(user);
    expect(view.status).toBe('REVOKED');
    expect(payment.delete).toHaveBeenCalledWith('/affiliations/yape', { identity: user });
  });
});

describe('CreateYapeAffiliationDto (validación · body OPCIONAL)', () => {
  const VALID_BODY = { documentType: 'DN' as const, document: '12345678' };

  it('acepta body VACÍO (UN TAP: documento del perfil)', () => {
    expect(errorsOf({})).toHaveLength(0);
  });

  it('acepta {documentType, document} válido (DNI)', () => {
    expect(errorsOf(VALID_BODY)).toHaveLength(0);
  });

  it('rechaza documentType fuera de DN|CE|PP', () => {
    expect(errorsOf({ ...VALID_BODY, documentType: 'RUC' })).toContain('isEnum');
  });

  it('valida document SEGÚN documentType (cuando se envía)', () => {
    expect(errorsOf({ ...VALID_BODY, documentType: 'DN', document: '123' })).toContain('documentMatchesType');
    expect(errorsOf({ ...VALID_BODY, documentType: 'CE', document: '123456789' })).toHaveLength(0);
    expect(errorsOf({ ...VALID_BODY, documentType: 'PP', document: 'AB123456' })).toHaveLength(0);
    expect(errorsOf({ ...VALID_BODY, documentType: 'PP', document: 'AB' })).toContain('documentMatchesType');
  });

  it('rechaza document presente SIN documentType (no se puede validar la forma)', () => {
    expect(errorsOf({ document: '12345678' })).toContain('documentMatchesType');
  });
});
