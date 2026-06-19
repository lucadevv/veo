/**
 * Test del feed de conductores cercanos (DispatchService.getNearby · GET /dispatch/nearby).
 * Verifica la delegación firmada a dispatch GetNearbyDrivers y la reproyección a {vehicles:[...]}
 * SIN driverId (privacidad por construcción: el reply gRPC no lo trae y el view tampoco lo declara).
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient } from '@veo/rpc';
import { DispatchService } from './dispatch.service';
import type { NearbyDriversReply } from '../infra/grpc-types';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function makeService(reply: NearbyDriversReply) {
  const call = vi.fn().mockResolvedValue(reply);
  const grpc = { call } as unknown as GrpcServiceClient;
  const svc = new DispatchService(grpc, SECRET, InternalAudience.PUBLIC_RAIL);
  return { svc, call };
}

describe('DispatchService · getNearby (feed de ambiente anónimo)', () => {
  it('delega a dispatch GetNearbyDrivers con lat/lon/vehicleType e identidad firmada', async () => {
    const { svc, call } = makeService({ drivers: [] });
    await svc.getNearby(user, -12.0464, -77.0428, 'CAR');
    expect(call).toHaveBeenCalledWith(
      'GetNearbyDrivers',
      { lat: -12.0464, lon: -77.0428, vehicleType: 'CAR' },
      expect.any(Object),
    );
  });

  it('manda vehicleType "" cuando el pasajero no filtra por tipo', async () => {
    const { svc, call } = makeService({ drivers: [] });
    await svc.getNearby(user, -12.0464, -77.0428);
    expect(call).toHaveBeenCalledWith(
      'GetNearbyDrivers',
      { lat: -12.0464, lon: -77.0428, vehicleType: '' },
      expect.any(Object),
    );
  });

  it('reproyecta a {vehicles:[{lat,lon,vehicleType}]} SIN driverId', async () => {
    const { svc } = makeService({
      drivers: [
        { lat: -12.046, lon: -77.043, vehicleType: 'CAR' },
        { lat: -12.047, lon: -77.044, vehicleType: 'MOTO' },
      ],
    });
    const view = await svc.getNearby(user, -12.0464, -77.0428);
    expect(view).toEqual({
      vehicles: [
        { lat: -12.046, lon: -77.043, vehicleType: 'CAR' },
        { lat: -12.047, lon: -77.044, vehicleType: 'MOTO' },
      ],
    });
    for (const v of view.vehicles) {
      expect(v).not.toHaveProperty('driverId');
    }
  });

  it('lista vacía cuando dispatch no devuelve conductores', async () => {
    const { svc } = makeService({ drivers: [] });
    const view = await svc.getNearby(user, -12.0464, -77.0428);
    expect(view).toEqual({ vehicles: [] });
  });
});
