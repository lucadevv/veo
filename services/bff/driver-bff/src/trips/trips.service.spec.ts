/**
 * A1 · anti-IDOR del start (lado conductor). ANTES de iniciar el viaje (y de exponer el código de modo
 * niño a fuerza bruta), el BFF:
 *  - DERIVA el driverId del perfil del conductor (GetDriverByUser → driver.id) desde la identidad;
 *  - hace GetTrip y verifica que el viaje es de ESTE conductor (trip.driverId === driver.id);
 *  - bloquea con 403 un viaje ajeno (Forbidden) y 404 uno inexistente (NotFound);
 *  - pasa el driverId DERIVADO al trip-service en el body (2da capa de defensa), nunca uno del cliente.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@veo/utils';
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
    // `toTripView` normaliza el status (lanza si es desconocido). El fixture debe traer un status
    // válido; antes faltaba y el test de getTrip propio reventaba con "Estado de viaje desconocido".
    status: 'IN_PROGRESS',
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
      identity: { ...identity, driverId: 'drv-9' }, // anti-IDOR: el BFF firma el driverId derivado en la identidad
      body: { childCode: '1234', driverId: 'drv-9' },
    });
  });

  it('un viaje de OTRO conductor → 403 Forbidden y NO llama al trip-service', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service, post } = makeService({ tripFound: false });
    await expect(service.start('trip-1', { childCode: '1234' }, identity)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TripsService.route — anti-IDOR (la ruta expone recojo/paradas/destino · PII de ubicación)', () => {
  it('un viaje de OTRO conductor → 403 Forbidden (NO resuelve la ruta ajena)', async () => {
    const { service } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    // Si llegara a resolver la ruta, maps={} crashearía con TypeError; un ForbiddenError PRUEBA que
    // cortó en el gate de ownership ANTES de exponer origin/destino/paradas del viaje ajeno.
    await expect(service.route('trip-1', identity)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service } = makeService({ driverFound: false });
    await expect(service.route('trip-1', identity)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service } = makeService({ tripFound: false });
    await expect(service.route('trip-1', identity)).rejects.toBeInstanceOf(NotFoundError);
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
      identity: { ...identity, driverId: 'drv-9' }, // anti-IDOR: el BFF firma el driverId derivado en la identidad
      body: { cashCollected: true, driverId: 'drv-9' },
    });
  });

  it('sin cashCollected (viaje digital o el conductor no cobró) → cashCollected undefined, igual completa', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    await service.complete('trip-1', {}, identity);
    expect(post).toHaveBeenCalledWith('/trips/trip-1/complete', {
      identity: { ...identity, driverId: 'drv-9' }, // anti-IDOR: el BFF firma el driverId derivado en la identidad
      body: { cashCollected: undefined, driverId: 'drv-9' },
    });
  });

  it('un viaje de OTRO conductor → 403 Forbidden y NO llama al trip-service', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service, post } = makeService({ tripFound: false });
    await expect(service.complete('trip-1', { cashCollected: true }, identity)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TripsService.cancel — anti-IDOR (driverId derivado server-side)', () => {
  it('deriva el driverId del perfil y lo pasa al trip-service en el body (by=DRIVER, no del cliente)', async () => {
    const { service, post, call } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    await service.cancel('trip-1', { reason: 'pasajero no aparece' }, identity);
    // Ownership: GetDriverByUser (deriva driverId) + GetTrip (verifica pertenencia).
    expect(call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    expect(call).toHaveBeenCalledWith('trip', 'GetTrip', { id: 'trip-1' }, identity);
    // `by` se fija a DRIVER server-side y el driverId DERIVADO viaja al trip-service (2da capa).
    expect(post).toHaveBeenCalledWith('/trips/trip-1/cancel', {
      identity: { ...identity, driverId: 'drv-9' }, // anti-IDOR: el BFF firma el driverId derivado en la identidad
      body: { by: 'DRIVER', reason: 'pasajero no aparece', driverId: 'drv-9' },
    });
  });

  it('un viaje de OTRO conductor → 403 Forbidden y NO cancela (anti-IDOR + anti-reassign)', async () => {
    const { service, post } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.cancel('trip-1', { reason: 'x' }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('sin perfil de conductor para el usuario → 403 Forbidden', async () => {
    const { service, post } = makeService({ driverFound: false });
    await expect(service.cancel('trip-1', { reason: 'x' }, identity)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service, post } = makeService({ tripFound: false });
    await expect(service.cancel('trip-1', { reason: 'x' }, identity)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TripsService.getTrip — anti-IDOR (no enumerar datos de viajes ajenos · passengerId es PII)', () => {
  it('el viaje propio → devuelve el TripView (verifica ownership por driverId derivado)', async () => {
    const { service, call } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-9' });
    const view = await service.getTrip('trip-1', identity);
    expect(view.id).toBe('trip-1');
    expect(call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
  });

  it('un viaje de OTRO conductor → 404 NotFound (no filtra existencia ni expone passengerId)', async () => {
    const { service } = makeService({ driverId: 'drv-9', tripDriverId: 'drv-OTRO' });
    await expect(service.getTrip('trip-1', identity)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sin perfil de conductor para el usuario → 404 NotFound', async () => {
    const { service } = makeService({ driverFound: false });
    await expect(service.getTrip('trip-1', identity)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('viaje inexistente → 404 NotFound', async () => {
    const { service } = makeService({ tripFound: false });
    await expect(service.getTrip('trip-1', identity)).rejects.toBeInstanceOf(NotFoundError);
  });
});
