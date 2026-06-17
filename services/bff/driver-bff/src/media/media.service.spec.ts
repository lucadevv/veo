/**
 * Test de MediaService.issuePublisherToken — gate anti-IDOR (Lote 2.11 · V1):
 *  - el viaje debe estar asignado a ESTE conductor (driverId del PERFIL, derivado vía GetDriverByUser);
 *  - solo IN_PROGRESS habilita la cámara (mirror exacto del lado pasajero, public-bff videoGrant);
 *  - recién entonces se proxea el token al media-service.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { MediaService } from './media.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

/** Perfil de conductor de `usr-1`: el viaje referencia este `id` (drv-9), no el userId. */
const DRIVER = { id: 'drv-9', userId: 'usr-1', found: true };

function makeService(opts: { driverFound?: boolean; trip?: Record<string, unknown> | null }) {
  // GrpcGateway.call enruta por (service, method): identity→GetDriverByUser, trip→GetTrip.
  const grpc = {
    call: vi.fn((service: string) => {
      if (service === 'identity') {
        return Promise.resolve({ ...DRIVER, found: opts.driverFound ?? true });
      }
      return Promise.resolve(opts.trip ?? { found: false });
    }),
  };
  const post = vi.fn(() =>
    Promise.resolve({
      roomName: 'cabin:trip-1',
      token: 'tok',
      url: 'wss://lk',
      expiresInSeconds: 3600,
    }),
  );
  const rest = { client: vi.fn(() => ({ post })) };
  const service = new MediaService(grpc as never, rest as never);
  return { service, grpc, post, rest };
}

function trip(over: Record<string, unknown> = {}) {
  return { id: 'trip-1', driverId: 'drv-9', status: 'IN_PROGRESS', found: true, ...over };
}

describe('MediaService.issuePublisherToken — anti-IDOR (perfil + IN_PROGRESS)', () => {
  it('viaje de OTRO conductor → ForbiddenError (no proxea)', async () => {
    const { service, post } = makeService({ trip: trip({ driverId: 'drv-OTRO' }) });
    await expect(service.issuePublisherToken(identity, 'trip-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje que NO está IN_PROGRESS → ForbiddenError (no proxea)', async () => {
    const { service, post } = makeService({ trip: trip({ status: 'ASSIGNED' }) });
    await expect(service.issuePublisherToken(identity, 'trip-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → NotFoundError', async () => {
    const { service } = makeService({ trip: { found: false } });
    await expect(service.issuePublisherToken(identity, 'trip-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('sin perfil de conductor → ForbiddenError', async () => {
    const { service } = makeService({ driverFound: false, trip: trip() });
    await expect(service.issuePublisherToken(identity, 'trip-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('dueño + IN_PROGRESS → proxea al media-service y mapea el grant', async () => {
    const { service, post, rest } = makeService({ trip: trip() });
    const grant = await service.issuePublisherToken(identity, 'trip-1', 'Juan');

    expect(rest.client).toHaveBeenCalledWith('media');
    expect(post).toHaveBeenCalledWith('/media/rooms/trip-1/token', {
      identity,
      body: { name: 'Juan' },
    });
    expect(grant).toEqual({ url: 'wss://lk', token: 'tok', room: 'cabin:trip-1' });
  });

  it('sin name → usa el userId como nombre visible', async () => {
    const { service, post } = makeService({ trip: trip() });
    await service.issuePublisherToken(identity, 'trip-1');
    expect(post).toHaveBeenCalledWith('/media/rooms/trip-1/token', {
      identity,
      body: { name: 'usr-1' },
    });
  });
});
