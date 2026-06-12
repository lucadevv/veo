/**
 * Test del trust boundary del lado conductor en getOffer/accept/reject (anti-IDOR #9):
 *  - el driverId se DERIVA server-side (GetDriverByUser) y se firma en la identidad propagada;
 *  - el matchId del path NUNCA se confía sin antes firmar el driverId del conductor autenticado;
 *  - dispatch (el muro real) hace el ownership-check con ESE driverId firmado, no con el del cliente.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { DispatchService } from './dispatch.service';
import type { MatchReply } from '../common/grpc-replies';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };
const MATCH = '00000000-0000-0000-0000-000000000abc';

function matchReply(): MatchReply {
  return {
    found: true,
    id: MATCH,
    tripId: 'trip-1',
    driverId: 'drv-9',
    score: 1,
    attempt: 1,
    surgeMultiplier: 1,
    outcome: 'OFFERED',
    offeredAt: '2026-01-01T00:00:00.000Z',
    respondedAt: '',
  } as unknown as MatchReply;
}

function makeService(opts: { driverFound?: boolean; match?: MatchReply } = {}) {
  // grpc.call: GetMatch (dispatch) y GetDriverByUser (identity) llegan a la MISMA mock; discriminamos
  // por el método para devolver el reply correcto.
  const grpc = {
    call: vi.fn((service: string, method: string) => {
      if (service === 'identity' && method === 'GetDriverByUser') {
        return Promise.resolve({ id: 'drv-9', userId: 'usr-1', found: opts.driverFound ?? true });
      }
      return Promise.resolve(opts.match ?? matchReply());
    }),
  };
  const post = vi.fn((_path: string, _opts: { identity: AuthenticatedUser; body: unknown }) =>
    Promise.resolve({ ok: true }),
  );
  const rest = { client: vi.fn(() => ({ post, get: vi.fn() })) };
  const service = new DispatchService(grpc as never, rest as never);
  return { service, grpc, post };
}

const signed = { ...identity, driverId: 'drv-9' };

describe('DispatchService (driver-bff) — getOffer/accept/reject derivan driverId firmado (#9)', () => {
  it('getOffer DERIVA el driverId y propaga la identidad FIRMADA con driverId al GetMatch', async () => {
    const { service, grpc } = makeService();
    await service.getOffer(MATCH, identity);
    // 1) derivó el driverId vía GetDriverByUser (nunca del cliente).
    expect(grpc.call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    // 2) el GetMatch viaja con la identidad que YA lleva driverId firmado.
    expect(grpc.call).toHaveBeenCalledWith('dispatch', 'GetMatch', { matchId: MATCH }, signed);
  });

  it('accept propaga la identidad FIRMADA con driverId al endpoint interno', async () => {
    const { service, grpc, post } = makeService();
    await service.accept(MATCH, identity);
    expect(grpc.call).toHaveBeenCalledWith('identity', 'GetDriverByUser', { id: 'usr-1' }, identity);
    expect(post).toHaveBeenCalledWith(`/dispatch/offers/${MATCH}/accept`, {
      identity: signed,
      body: {},
    });
    // El identity propagado lleva el driverId derivado (lo verifica dispatch downstream).
    const arg = post.mock.calls[0]?.[1] as { identity: AuthenticatedUser };
    expect(arg.identity.driverId).toBe('drv-9');
  });

  it('reject propaga la identidad FIRMADA con driverId al endpoint interno', async () => {
    const { service, post } = makeService();
    await service.reject(MATCH, identity);
    expect(post).toHaveBeenCalledWith(`/dispatch/offers/${MATCH}/reject`, {
      identity: signed,
      body: {},
    });
  });

  it('getOffer/accept responden 404 si no hay perfil de conductor para el usuario', async () => {
    const { service } = makeService({ driverFound: false });
    await expect(service.getOffer(MATCH, identity)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(service.accept(MATCH, identity)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
