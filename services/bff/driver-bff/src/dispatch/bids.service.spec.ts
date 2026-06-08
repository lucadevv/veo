/**
 * Test de la PUJA · lado conductor (DispatchService.listOpenBids/submitOffer):
 *  - el driverId se DERIVA server-side (GetDriverByUser) y se firma en la identidad propagada;
 *  - el body de la oferta lleva el driverId derivado (nunca un param del cliente);
 *  - el 403 del gate de elegibilidad de dispatch se propaga limpio.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { DispatchService } from './dispatch.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function makeService(opts: {
  driverFound?: boolean;
  bids?: unknown;
  postImpl?: (...args: unknown[]) => Promise<unknown>;
}) {
  const grpc = {
    call: vi.fn(() =>
      Promise.resolve({ id: 'drv-9', userId: 'usr-1', found: opts.driverFound ?? true }),
    ),
  };
  const get = vi.fn(() => Promise.resolve(opts.bids ?? []));
  const post = vi.fn(opts.postImpl ?? (() => Promise.resolve({ tripId: 'trip-1', driverId: 'drv-9', kind: 'ACCEPT_PRICE', priceCents: 700, etaSeconds: 120, status: 'PENDING' })));
  const rest = { client: vi.fn(() => ({ get, post })) };
  const service = new DispatchService(grpc as never, rest as never);
  return { service, grpc, get, post };
}

describe('DispatchService — PUJA lado conductor (driverId server-side + gate downstream)', () => {
  it('listOpenBids deriva el driverId y lo pasa firmado + en el query a dispatch', async () => {
    const bids = [{ tripId: 'trip-1', bidCents: 700, vehicleType: 'CAR', expiresAt: 1, originLat: -12, originLon: -77 }];
    const { service, get, grpc } = makeService({ bids });
    const res = await service.listOpenBids(identity);
    expect(res).toEqual(bids);
    // El driverId se derivó vía GetDriverByUser (NUNCA un param del cliente).
    expect(grpc.call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    expect(get).toHaveBeenCalledWith('/bids/open', {
      identity: { ...identity, driverId: 'drv-9' },
      query: { driverId: 'drv-9' },
    });
  });

  it('submitOffer envía el driverId DERIVADO en el body (no del cliente)', async () => {
    const { service, post } = makeService({});
    await service.submitOffer('trip-1', 'COUNTER', 900, identity);
    expect(post).toHaveBeenCalledWith('/bids/trip-1/offers', {
      identity: { ...identity, driverId: 'drv-9' },
      body: { driverId: 'drv-9', kind: 'COUNTER', priceCents: 900 },
    });
  });

  it('submitOffer propaga el 403 del gate de elegibilidad de dispatch', async () => {
    const { service } = makeService({
      postImpl: () => Promise.reject(new ForbiddenError('Conductor no elegible')),
    });
    await expect(service.submitOffer('trip-1', 'ACCEPT_PRICE', 700, identity)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('listOpenBids responde 404 si no hay perfil de conductor para el usuario', async () => {
    const { service } = makeService({ driverFound: false });
    await expect(service.listOpenBids(identity)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
