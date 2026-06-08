/**
 * A1 · anti-IDOR del start (lado conductor). ANTES de iniciar el viaje (y de exponer el código de modo
 * niño a fuerza bruta), el BFF:
 *  - DERIVA el driverId del perfil del conductor (GetDriverByUser → driver.id) desde la identidad;
 *  - hace GetTrip y verifica que el viaje es de ESTE conductor (trip.driverId === driver.id);
 *  - bloquea con 403 un viaje ajeno (Forbidden) y 404 uno inexistente (NotFound);
 *  - pasa el driverId DERIVADO al trip-service en el body (2da capa de defensa), nunca uno del cliente.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import { TripsService } from './trips.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function makeService(opts: {
  driverFound?: boolean;
  driverId?: string;
  tripFound?: boolean;
  tripDriverId?: string;
}) {
  const driverReply = {
    id: opts.driverId ?? 'drv-9',
    userId: 'usr-1',
    found: opts.driverFound ?? true,
  };
  const tripReply = {
    id: 'trip-1',
    driverId: opts.tripDriverId ?? 'drv-9',
    found: opts.tripFound ?? true,
  };
  // grpc.call resuelve según el método: GetDriverByUser → perfil; GetTrip → viaje.
  const call = vi.fn((_svc: string, method: string) =>
    Promise.resolve(method === 'GetDriverByUser' ? driverReply : tripReply),
  );
  const grpc = { call };
  const post = vi.fn(() => Promise.resolve({ id: 'trip-1', status: 'IN_PROGRESS' }));
  const rest = { client: vi.fn(() => ({ post })) };
  const maps = {} as never;
  const service = new TripsService(grpc as never, rest as never, maps);
  return { service, grpc, post, call };
}

describe('TripsService.start — anti-IDOR (driverId derivado server-side)', () => {
  it('deriva el driverId del perfil y lo pasa al trip-service en el body (no del cliente)', async () => {
    const { service, post, call } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    await service.start('trip-1', { childCode: '1234' }, identity);
    // El driverId se derivó vía GetDriverByUser (NUNCA un param del cliente).
    expect(call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    expect(call).toHaveBeenCalledWith('trip', 'GetTrip', { id: 'trip-1' }, identity);
    expect(post).toHaveBeenCalledWith('/trips/trip-1/start', {
      identity,
      body: { childCode: '1234', driverId: 'drv-9' },
    });
  });

  it('un viaje de OTRO conductor → 403 Forbidden y NO llama al trip-service', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service, post } = makeService({ tripFound: false });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TripsService.complete — EFECTIVO + anti-IDOR (driverId derivado server-side)', () => {
  it('deriva el driverId y propaga cashCollected al trip-service (el cliente no envía driverId)', async () => {
    const { service, post, call } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    await service.complete('trip-1', { cashCollected: true }, identity);
    // Ownership: GetDriverByUser (deriva driverId) + GetTrip (verifica pertenencia).
    expect(call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    expect(call).toHaveBeenCalledWith('trip', 'GetTrip', { id: 'trip-1' }, identity);
    // El cashCollected viaja al trip-service junto al driverId DERIVADO (nunca uno del cliente).
    expect(post).toHaveBeenCalledWith('/trips/trip-1/complete', {
      identity,
      body: { cashCollected: true, driverId: 'drv-9' },
    });
  });

  it('sin cashCollected (viaje digital o el conductor no cobró) → cashCollected undefined, igual completa', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    await service.complete('trip-1', {}, identity);
    expect(post).toHaveBeenCalledWith('/trips/trip-1/complete', {
      identity,
      body: { cashCollected: undefined, driverId: 'drv-9' },
    });
  });

  it('un viaje de OTRO conductor → 403 Forbidden y NO llama al trip-service', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service, post } = makeService({ tripFound: false });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
