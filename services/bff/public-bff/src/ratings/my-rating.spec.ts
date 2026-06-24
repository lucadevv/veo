/**
 * Test del contrato MI calificación de un viaje (RatingsService.getMyRatingForTrip):
 *  - Devuelve { stars, comment, createdAt } cuando el pasajero YA calificó.
 *  - 404 del downstream (sin rating tuyo) → null (no error para la app).
 *  - Cualquier OTRO error del downstream (5xx/timeout) se propaga (no se enmascara como "sin rating").
 *  - Anti-IDOR: el rater NO viaja en el query; el BFF propaga la identidad firmada (el rating-service
 *    filtra por ese rater). El BFF NUNCA acepta un raterId del cliente.
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import { DownstreamError, type GrpcServiceClient, type InternalRestClient } from '@veo/rpc';
import { RatingsService } from './ratings.service';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'pax-1', type: 'passenger', roles: [], sessionId: 's1' };

const RATING = {
  id: 'rat-1',
  tripId: 'trip-1',
  raterId: 'pax-1',
  ratedId: 'drv-1',
  stars: 5,
  comment: '¡Excelente!',
  createdAt: '2026-06-07T12:00:00.000Z',
};

function makeService(restGet: ReturnType<typeof vi.fn>) {
  const grpcStub = {} as unknown as GrpcServiceClient;
  const rest = { get: restGet, post: vi.fn() } as unknown as InternalRestClient;
  return new RatingsService(grpcStub, rest, SECRET, InternalAudience.PUBLIC_RAIL);
}

function makeServiceWithGrpc(grpcCall: ReturnType<typeof vi.fn>) {
  const grpc = { call: grpcCall } as unknown as GrpcServiceClient;
  const rest = { get: vi.fn(), post: vi.fn() } as unknown as InternalRestClient;
  return new RatingsService(grpc, rest, SECRET, InternalAudience.PUBLIC_RAIL);
}

describe('RatingsService.getMyRatingForTrip', () => {
  it('devuelve { stars, comment, createdAt } cuando el pasajero ya calificó', async () => {
    const get = vi.fn().mockResolvedValue(RATING);
    const svc = makeService(get);

    const view = await svc.getMyRatingForTrip(user, 'trip-1');

    expect(view).toEqual({
      stars: 5,
      comment: '¡Excelente!',
      createdAt: '2026-06-07T12:00:00.000Z',
    });
    // El contrato a la app es mínimo: NO filtra raterId/ratedId/id (no los necesita y son ruido/PII).
    expect(view).not.toHaveProperty('raterId');
    expect(view).not.toHaveProperty('id');
  });

  it('propaga la identidad firmada y el tripId (anti-IDOR: el rater NO viaja en el query)', async () => {
    const get = vi.fn().mockResolvedValue(RATING);
    const svc = makeService(get);

    await svc.getMyRatingForTrip(user, 'trip-1');

    expect(get).toHaveBeenCalledWith('/ratings', { identity: user, query: { tripId: 'trip-1' } });
    // El query SOLO lleva tripId: el rater se deriva server-side de la identidad, nunca del cliente.
    const [, opts] = get.mock.calls[0] as [string, { query: Record<string, unknown> }];
    expect(opts.query).not.toHaveProperty('raterId');
    expect(opts.query).not.toHaveProperty('userId');
  });

  it('404 del downstream (sin rating tuyo) → null (no es error para la app)', async () => {
    const get = vi.fn().mockRejectedValue(new DownstreamError(404, 'NOT_FOUND', 'no hay rating'));
    const svc = makeService(get);

    await expect(svc.getMyRatingForTrip(user, 'trip-1')).resolves.toBeNull();
  });

  it('propaga cualquier OTRO error del downstream (5xx) — NO lo enmascara como "sin rating"', async () => {
    const get = vi.fn().mockRejectedValue(new DownstreamError(503, 'UNAVAILABLE', 'caído'));
    const svc = makeService(get);

    await expect(svc.getMyRatingForTrip(user, 'trip-1')).rejects.toMatchObject({ status: 503 });
  });

  it('comment null se preserva (rating sin comentario)', async () => {
    const get = vi.fn().mockResolvedValue({ ...RATING, comment: null });
    const svc = makeService(get);

    const view = await svc.getMyRatingForTrip(user, 'trip-1');
    expect(view?.comment).toBeNull();
  });
});

describe('RatingsService.getAggregate · contrato del pasajero sin moderación (anti-IDOR)', () => {
  it('NO expone flagged/flagReason aunque el reply gRPC los traiga (fuga de moderación cerrada)', async () => {
    // El reply gRPC PODRÍA traer flags (el rating-service los zeroea para public-rail, pero el BFF no
    // depende de eso): el contrato del pasajero NO debe tener los campos de moderación de ningún modo.
    const call = vi.fn().mockResolvedValue({
      subjectId: 'drv-1',
      role: 'DRIVER',
      rollingAvg30d: 4.7,
      count30d: 120,
      flagged: true,
      flagReason: 'suspension',
      lastComputedAt: '2026-06-01T00:00:00.000Z',
    });
    const svc = makeServiceWithGrpc(call);

    const view = await svc.getAggregate(user, 'drv-1');

    expect(view).toEqual({
      subjectId: 'drv-1',
      role: 'DRIVER',
      rollingAvg30d: 4.7,
      count30d: 120,
      lastComputedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(view).not.toHaveProperty('flagged');
    expect(view).not.toHaveProperty('flagReason');
  });
});
