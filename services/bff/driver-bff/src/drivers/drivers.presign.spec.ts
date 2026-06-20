/**
 * Test del ticket de subida de documentos (presigned PUT) del lado conductor:
 *  - la key S3 es DRIVER-SCOPED (`drivers/{driverId}/...`), con el driverId DERIVADO server-side
 *    (GetDriverByUser) — el cliente nunca lo envía: ESA es la frontera de seguridad (Ley 29733);
 *  - la extensión sale del contentType vía el mapa tipado (jpg/png/pdf), no de un nombre del cliente;
 *  - el driver-bff propaga al media-service el bucket de documentos + contentType + ttl;
 *  - si no existe perfil de conductor, falla (NotFoundError) sin llamar a media.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
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
  const post = vi.fn((_path: string, _opts: { identity: AuthenticatedUser; body: unknown }) =>
    Promise.resolve({
      url: 'https://signed.example/upload',
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
    }),
  );
  const rest = { client: vi.fn(() => ({ post, get: vi.fn(), patch: vi.fn() })) };
  const config = {
    getOrThrow: vi.fn((key: string) =>
      key === 'S3_BUCKET_DOCUMENTS' ? 'veo-documents-dev' : 300,
    ),
  };
  const service = new DriversService(grpc as never, rest as never, config as never);
  return { service, grpc, post };
}

describe('DriversService.presignDocumentUpload (driver-bff) — key driver-scoped + media presign-put', () => {
  it('SIN sides: devuelve UN ticket SINGLE driver-scoped (backward-compat 1 imagen)', async () => {
    const { service, grpc } = makeService();

    const view = await service.presignDocumentUpload(identity, {
      type: FleetDocumentType.LICENSE_A1,
      contentType: 'image/jpeg',
    });

    // El driverId se derivó vía GetDriverByUser con el userId autenticado.
    expect(grpc.call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    // Backward-compat: sin `sides` → un solo ticket SINGLE.
    expect(view.tickets).toHaveLength(1);
    const ticket = view.tickets[0]!;
    expect(ticket.side).toBe(DocumentSide.SINGLE);
    // Frontera de seguridad: la key arranca con el prefijo del propio conductor.
    expect(ticket.fileS3Key.startsWith('drivers/drv-9/documents/LICENSE_A1/')).toBe(true);
    expect(ticket.uploadUrl).toBe('https://signed.example/upload');
    expect(ticket.requiredHeaders).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(typeof view.expiresAt).toBe('string');
  });

  it('CON sides [FRONT, BACK]: devuelve N tickets (uno por cara) con keys DISTINTAS driver-scoped', async () => {
    const { service, post } = makeService();

    const view = await service.presignDocumentUpload(identity, {
      type: FleetDocumentType.LICENSE_A1,
      contentType: 'image/jpeg',
      sides: [DocumentSide.FRONT, DocumentSide.BACK],
    });

    // Un ticket por cara, en orden, con la cara reflejada.
    expect(view.tickets).toHaveLength(2);
    expect(view.tickets.map((t) => t.side)).toEqual([DocumentSide.FRONT, DocumentSide.BACK]);
    // Una key (y un presign-put) por cara: distintas entre sí (el uuid de la key las separa).
    const keys = view.tickets.map((t) => t.fileS3Key);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key.startsWith('drivers/drv-9/documents/LICENSE_A1/')).toBe(true);
    }
    // Un presign-put de media por cara.
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('propaga al media-service el bucket de documentos, la key, el contentType y el ttl', async () => {
    const { service, post } = makeService();

    const view = await service.presignDocumentUpload(identity, {
      type: FleetDocumentType.SOAT,
      contentType: 'application/pdf',
    });

    expect(post).toHaveBeenCalledWith(
      '/media/internal/presign-put',
      expect.objectContaining({
        identity,
        body: {
          bucket: 'veo-documents-dev',
          key: view.tickets[0]!.fileS3Key,
          contentType: 'application/pdf',
          ttlSeconds: 300,
        },
      }),
    );
  });

  it('deriva la extensión del contentType vía el mapa tipado (png → .png)', async () => {
    const { service } = makeService();

    const view = await service.presignDocumentUpload(identity, {
      type: FleetDocumentType.PROPERTY_CARD,
      contentType: 'image/png',
    });

    const key = view.tickets[0]!.fileS3Key;
    expect(key.endsWith('.png')).toBe(true);
    expect(key).toMatch(/^drivers\/drv-9\/documents\/PROPERTY_CARD\/[^/]+\.png$/);
  });

  it('falla con NotFoundError y NO llama a media si no existe perfil de conductor', async () => {
    const { service, post } = makeService({ driverFound: false });

    await expect(
      service.presignDocumentUpload(identity, {
        type: FleetDocumentType.LICENSE_A1,
        contentType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });
});
