/**
 * Test del avatar del conductor en el driver-bff (espejo del public-bff):
 *  - presign PROXYA a media-service (`/media/avatars/presign`) con la identidad propagada;
 *  - confirm PROXYA a media-service (`/media/avatars/confirm`) Y persiste la foto en el perfil vía
 *    identity por el RIEL del conductor (`PATCH /drivers/me/photo`) con la `publicUrl` sellada;
 *  - el userId sale de la identidad propagada en ambos hops (anti-IDOR): el cliente nunca lo envía.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { DriversService } from './drivers.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

const TICKET = {
  uploadUrl: 'https://signed.example/upload',
  method: 'PUT' as const,
  headers: { 'Content-Type': 'image/jpeg' },
  key: 'avatars/usr-1/avatar.jpg',
  publicUrl: 'https://cdn.veo.pe/veo-avatars/avatars/usr-1/avatar.jpg',
  expiresInSeconds: 300,
  maxBytes: 5_000_000,
};
const CONFIRMED = { key: TICKET.key, publicUrl: TICKET.publicUrl, sizeBytes: 120_000 };

function makeService() {
  // Un cliente REST por servicio downstream, para poder aseverar QUÉ servicio recibió qué llamada.
  const mediaPost = vi.fn((path: string) =>
    Promise.resolve(path.endsWith('/presign') ? TICKET : CONFIRMED),
  );
  const identityPatch = vi.fn(() => Promise.resolve({ photoUrl: TICKET.publicUrl }));
  const clients: Record<string, unknown> = {
    media: { post: mediaPost, get: vi.fn(), patch: vi.fn() },
    identity: { post: vi.fn(), get: vi.fn(), patch: identityPatch },
  };
  const rest = { client: vi.fn((service: string) => clients[service]) };
  const grpc = { call: vi.fn() };
  const activeVehicleType = { invalidate: vi.fn(), resolve: vi.fn() };
  const config = {
    getOrThrow: vi.fn((key: string) => (key === 'S3_BUCKET_DOCUMENTS' ? 'veo-documents-dev' : 300)),
  };
  const service = new DriversService(
    grpc as never,
    rest as never,
    activeVehicleType as never,
    config as never,
  );
  return { service, rest, mediaPost, identityPatch };
}

describe('DriversService avatar (driver-bff) — presign/confirm espejo del pasajero', () => {
  it('presignAvatarUpload PROXYA a media-service con la identidad propagada', async () => {
    const { service, rest, mediaPost } = makeService();

    const ticket = await service.presignAvatarUpload(identity, {
      contentType: 'image/jpeg',
      ext: 'jpg',
    });

    expect(rest.client).toHaveBeenCalledWith('media');
    expect(mediaPost).toHaveBeenCalledWith('/media/avatars/presign', {
      identity,
      body: { contentType: 'image/jpeg', ext: 'jpg' },
    });
    expect(ticket).toEqual(TICKET);
  });

  it('confirmAvatarUpload valida en media Y persiste la foto en identity (driver-rail)', async () => {
    const { service, rest, mediaPost, identityPatch } = makeService();

    const confirmed = await service.confirmAvatarUpload(identity, { key: TICKET.key });

    // 1) Confirmación de cuota en media-service.
    expect(mediaPost).toHaveBeenCalledWith('/media/avatars/confirm', {
      identity,
      body: { key: TICKET.key },
    });
    // 2) Persistencia de la foto en el perfil vía identity, con la publicUrl SELLADA por el confirm.
    expect(rest.client).toHaveBeenCalledWith('identity');
    expect(identityPatch).toHaveBeenCalledWith('/drivers/me/photo', {
      identity,
      body: { photoUrl: CONFIRMED.publicUrl },
    });
    expect(confirmed).toEqual(CONFIRMED);
  });
});
