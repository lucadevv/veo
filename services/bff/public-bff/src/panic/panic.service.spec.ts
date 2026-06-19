/** Test del gate anti-IDOR en la lectura del estado de pánico (PanicService.getPanic). */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { PanicService } from './panic.service';
import type { PanicReply } from '../infra/grpc-types';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

const OWN_PANIC: PanicReply = {
  id: 'pnc-1',
  tripId: 'trip-1',
  passengerId: 'usr-1',
  status: 'ACKNOWLEDGED',
  geoLat: -12.0464,
  geoLon: -77.0428,
  triggeredAt: '2026-06-05T10:00:00.000Z',
  acknowledgedAt: '2026-06-05T10:00:03.000Z',
  ackBy: 'op-9',
  found: true,
};

function makeService(reply: PanicReply) {
  const panicGrpc = {
    call: vi.fn().mockResolvedValue(reply),
  } as unknown as GrpcServiceClient;
  const rest = {} as unknown as InternalRestClient;
  return new PanicService(panicGrpc, rest, SECRET, InternalAudience.PUBLIC_RAIL);
}

describe('PanicService.getPanic', () => {
  it('devuelve el PanicView de la propia alerta del pasajero', async () => {
    const svc = makeService(OWN_PANIC);
    const view = await svc.getPanic(user, 'pnc-1');
    expect(view.id).toBe('pnc-1');
    expect(view.passengerId).toBe('usr-1');
    expect(view.geo).toEqual({ lat: -12.0464, lon: -77.0428 });
    expect(view.acknowledgedAt).toBe('2026-06-05T10:00:03.000Z');
  });

  it('rechaza (403 Forbidden) si la alerta de pánico es de otro pasajero', async () => {
    const svc = makeService({ ...OWN_PANIC, passengerId: 'otro' });
    await expect(svc.getPanic(user, 'pnc-1')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('responde 404 (NotFound) si la alerta de pánico no existe', async () => {
    const svc = makeService({ ...OWN_PANIC, found: false, passengerId: '' });
    await expect(svc.getPanic(user, 'pnc-1')).rejects.toMatchObject({ httpStatus: 404 });
  });
});
