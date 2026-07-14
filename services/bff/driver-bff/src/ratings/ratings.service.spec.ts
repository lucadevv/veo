/**
 * Contrato del RatingsService del driver-bff (espejo del public-bff, lado conductor):
 *  - create → POST /ratings al rating-service con la identidad firmada + el body (anti-IDOR: el raterId
 *    NUNCA viaja en el body; el rating-service lo deriva de la identidad). El conductor califica al PASAJERO.
 *  - getMyRatingForTrip → { stars, comment, createdAt } cuando YA calificó.
 *  - 404 del downstream (sin rating tuyo) → null (no es error para la app).
 *  - Cualquier OTRO error (5xx/timeout) se PROPAGA (no se enmascara como "sin rating").
 */
import { describe, it, expect, vi } from 'vitest';
import { type AuthenticatedUser } from '@veo/auth';
import { DownstreamError, type InternalRestClient } from '@veo/rpc';
import { RatingsService } from './ratings.service';
import type { RestGateway } from '../infra/rest.gateway';

// El userId de SESIÓN del conductor ≠ su id de PERFIL (trip.driverId): el service lo resuelve por
// gRPC (GetDriverByUser) y lo firma en la identidad — el fix del 403 "No participaste de este viaje".
const user: AuthenticatedUser = { userId: 'usr-drv-1', type: 'driver', roles: [], sessionId: 's1' };
const identityWithDriver: AuthenticatedUser = { ...user, driverId: 'drv-1' };

const RATING = {
  id: 'rat-1',
  tripId: 'trip-1',
  raterId: 'drv-1',
  ratedId: 'pax-1',
  stars: 5,
  comment: '¡Puntual y amable!',
  createdAt: '2026-07-07T12:00:00.000Z',
};

function makeService(client: Partial<InternalRestClient>) {
  const gateway = { client: () => client as InternalRestClient } as unknown as RestGateway;
  // GetDriverByUser resuelve usr-drv-1 → perfil drv-1 (el driverId que exige el gate del rating-service).
  const grpc = { call: vi.fn().mockResolvedValue({ found: true, id: 'drv-1' }) } as never;
  return new RatingsService(gateway, grpc);
}

describe('RatingsService.create · el conductor califica al pasajero', () => {
  it('POSTea /ratings con la identidad firmada y el body (anti-IDOR: sin raterId en el body)', async () => {
    const post = vi.fn().mockResolvedValue(RATING);
    const svc = makeService({ post });

    const dto = {
      tripId: 'trip-1',
      ratedId: 'pax-1',
      ratedRole: 'PASSENGER' as const,
      stars: 5,
      comment: '¡Puntual y amable!',
    };
    const result = await svc.create(user, dto);

    expect(result).toEqual(RATING);
    // La identidad firmada lleva el driverId RESUELTO (no el crudo del JWT).
    expect(post).toHaveBeenCalledWith('/ratings', { identity: identityWithDriver, body: dto });
    // El body NO lleva raterId: lo deriva el rating-service de la identidad firmada.
    const [, opts] = post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(opts.body).not.toHaveProperty('raterId');
  });
});

describe('RatingsService.getMyRatingForTrip', () => {
  it('devuelve { stars, comment, createdAt } cuando el conductor ya calificó', async () => {
    const get = vi.fn().mockResolvedValue(RATING);
    const svc = makeService({ get });

    const view = await svc.getMyRatingForTrip(user, 'trip-1');

    expect(view).toEqual({
      stars: 5,
      comment: '¡Puntual y amable!',
      createdAt: '2026-07-07T12:00:00.000Z',
    });
    // Contrato mínimo a la app: NO filtra raterId/ratedId/id (ruido/PII que no necesita).
    expect(view).not.toHaveProperty('raterId');
    expect(view).not.toHaveProperty('id');
  });

  it('propaga la identidad firmada y el tripId (anti-IDOR: el rater NO viaja en el query)', async () => {
    const get = vi.fn().mockResolvedValue(RATING);
    const svc = makeService({ get });

    await svc.getMyRatingForTrip(user, 'trip-1');

    expect(get).toHaveBeenCalledWith('/ratings', { identity: identityWithDriver, query: { tripId: 'trip-1' } });
    const [, opts] = get.mock.calls[0] as [string, { query: Record<string, unknown> }];
    expect(opts.query).not.toHaveProperty('raterId');
    expect(opts.query).not.toHaveProperty('userId');
  });

  it('404 del downstream (sin rating tuyo) → null (no es error para la app)', async () => {
    const get = vi.fn().mockRejectedValue(new DownstreamError(404, 'NOT_FOUND', 'no hay rating'));
    const svc = makeService({ get });

    await expect(svc.getMyRatingForTrip(user, 'trip-1')).resolves.toBeNull();
  });

  it('propaga cualquier OTRO error del downstream (5xx) — NO lo enmascara como "sin rating"', async () => {
    const get = vi.fn().mockRejectedValue(new DownstreamError(503, 'UNAVAILABLE', 'caído'));
    const svc = makeService({ get });

    await expect(svc.getMyRatingForTrip(user, 'trip-1')).rejects.toMatchObject({ status: 503 });
  });

  it('comment null se preserva (rating sin comentario)', async () => {
    const get = vi.fn().mockResolvedValue({ ...RATING, comment: null });
    const svc = makeService({ get });

    const view = await svc.getMyRatingForTrip(user, 'trip-1');
    expect(view?.comment).toBeNull();
  });
});
