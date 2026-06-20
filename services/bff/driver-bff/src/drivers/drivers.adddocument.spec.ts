/**
 * Test de DriversService.addDocument (driver-bff) — anti-IDOR de STORAGE (Ley 29733).
 *
 * El borde público recibe las KEYS S3 del cliente. El driverId se resuelve server-side (GetDriverByUser)
 * y TODA key entrante (`fileS3Key` legacy + cada `images[].s3Key`) DEBE vivir bajo el prefijo del propio
 * conductor (`drivers/{driverId}/`), espejando `media-service avatar.service.assertOwnsKey`:
 *  - key legítima `drivers/{miId}/documents/...` → pasa (se proxya a fleet);
 *  - key cross-driver `drivers/OTRO/...` → ForbiddenError (403), NO se proxya a fleet;
 *  - key sin prefijo driver-scoped → ForbiddenError (403).
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { DocumentSide } from '@veo/shared-types';
import { DriversService } from './drivers.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function makeService(opts: { driverFound?: boolean } = {}) {
  const grpc = {
    call: vi.fn((service: string, method: string) => {
      if (service === 'identity' && method === 'GetDriverByUser') {
        return Promise.resolve({ id: 'drv-9', userId: 'usr-1', found: opts.driverFound ?? true });
      }
      return Promise.resolve({});
    }),
  };
  // El POST a fleet devuelve un FleetDocumentReply mínimo; lo importante es SI se llamó o no.
  const post = vi.fn((_path: string, _opts: { identity: AuthenticatedUser; body: unknown }) =>
    Promise.resolve({
      id: 'doc-1',
      ownerId: 'drv-9',
      type: 'LICENSE_A1',
      status: 'PENDING_REVIEW',
      images: [],
    }),
  );
  const rest = { client: vi.fn(() => ({ post, get: vi.fn(), patch: vi.fn() })) };
  const config = {
    getOrThrow: vi.fn((key: string) => (key === 'S3_BUCKET_DOCUMENTS' ? 'veo-documents-dev' : 300)),
  };
  const service = new DriversService(grpc as never, rest as never, config as never);
  return { service, grpc, post };
}

describe('DriversService.addDocument (driver-bff) — anti-IDOR storage (prefijo driver-scoped)', () => {
  it('OK: fileS3Key bajo el prefijo del propio conductor → proxya a fleet', async () => {
    const { service, post } = makeService();
    await service.addDocument(identity, {
      type: 'LICENSE_A1',
      documentNumber: 'A1-1',
      fileS3Key: 'drivers/drv-9/documents/LICENSE_A1/abc.jpg',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/documents',
      expect.objectContaining({
        body: expect.objectContaining({ ownerId: 'drv-9', ownerType: 'DRIVER' }),
      }),
    );
  });

  it('OK: images[] bajo el prefijo del propio conductor → proxya a fleet', async () => {
    const { service, post } = makeService();
    await service.addDocument(identity, {
      type: 'LICENSE_A1',
      documentNumber: 'A1-1',
      images: [
        { s3Key: 'drivers/drv-9/documents/LICENSE_A1/front.jpg', side: DocumentSide.FRONT },
        { s3Key: 'drivers/drv-9/documents/LICENSE_A1/back.jpg', side: DocumentSide.BACK },
      ],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('RECHAZA: fileS3Key cross-driver `drivers/OTRO/...` → ForbiddenError, NO proxya a fleet', async () => {
    const { service, post } = makeService();
    await expect(
      service.addDocument(identity, {
        type: 'LICENSE_A1',
        documentNumber: 'A1-1',
        fileS3Key: 'drivers/drv-OTRO/documents/LICENSE_A1/leak.jpg',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(post).not.toHaveBeenCalled();
  });

  it('RECHAZA: una image cross-driver entre varias legítimas → ForbiddenError, NO proxya a fleet', async () => {
    const { service, post } = makeService();
    await expect(
      service.addDocument(identity, {
        type: 'LICENSE_A1',
        documentNumber: 'A1-1',
        images: [
          { s3Key: 'drivers/drv-9/documents/LICENSE_A1/front.jpg', side: DocumentSide.FRONT },
          { s3Key: 'drivers/drv-OTRO/documents/LICENSE_A1/back.jpg', side: DocumentSide.BACK },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(post).not.toHaveBeenCalled();
  });

  it('RECHAZA: key SIN prefijo driver-scoped → ForbiddenError, NO proxya a fleet', async () => {
    const { service, post } = makeService();
    await expect(
      service.addDocument(identity, {
        type: 'LICENSE_A1',
        documentNumber: 'A1-1',
        fileS3Key: 'arbitrary/key.jpg',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(post).not.toHaveBeenCalled();
  });

  it('falla con NotFoundError si no existe perfil de conductor (antes de validar keys)', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(
      service.addDocument(identity, {
        type: 'LICENSE_A1',
        documentNumber: 'A1-1',
        fileS3Key: 'drivers/drv-9/documents/LICENSE_A1/abc.jpg',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });
});
