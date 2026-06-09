import { describe, it, expect, vi } from 'vitest';
import { OpsService } from './ops.service';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { NotFoundError } from '@veo/utils';
import type { ReadModelService } from '../read-model/read-model.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';

const identity: AuthenticatedUser = { userId: 'op1', type: 'admin', roles: ['ADMIN'], sessionId: 's1' };

function grpc(impl: (method: string, req: Record<string, unknown>) => unknown): GrpcServiceClient {
  return { call: vi.fn((method: string, req: Record<string, unknown>) => Promise.resolve(impl(method, req))) } as unknown as GrpcServiceClient;
}

const config = { get: () => 'secret' } as unknown as ConfigService<Env, true>;
const noopAudit = { record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }) } as unknown as AuditRecorder;
const noopReadModel = {} as unknown as ReadModelService;
const noopRest = {} as unknown as InternalRestClient;

describe('OpsService.tripDetail (agregador gRPC → contrato PLANO tripDetail)', () => {
  it('aplana al contrato: createdAt←requestedAt, origin/destination de coords, nombres de identity', async () => {
    const tripGrpc = grpc((m) => {
      if (m === 'GetTrip')
        return {
          id: 't1',
          passengerId: 'p1',
          driverId: 'd1',
          vehicleId: 'v1',
          status: 'COMPLETED',
          fareCents: 2500,
          currency: 'PEN',
          distanceMeters: 8000,
          durationSeconds: 1200,
          paymentMethod: 'YAPE',
          childMode: false,
          penaltyCents: 0,
          requestedAt: '2026-06-01T10:00:00.000Z',
          originLat: -12.05,
          originLng: -77.04,
          destinationLat: -12.1,
          destinationLng: -77.0,
          found: true,
        };
      return {};
    });
    const identityGrpc = grpc((m) => {
      if (m === 'GetUser') return { id: 'p1', type: 'passenger', kycStatus: 'VERIFIED', name: 'Ana Pérez', deleted: false, found: true };
      if (m === 'GetDriver')
        return { id: 'd1', userId: 'u-d1', currentStatus: 'AVAILABLE', backgroundCheckStatus: 'CLEARED', averageRating: 4.8, name: 'Khalid Ríos', found: true };
      return {};
    });

    const svc = new OpsService(tripGrpc, identityGrpc, noopRest, noopReadModel, noopAudit, config);
    const view = await svc.tripDetail(identity, 't1');

    expect(view.status).toBe('COMPLETED');
    expect(view.fareCents).toBe(2500);
    expect(view.createdAt).toBe('2026-06-01T10:00:00.000Z'); // ← requestedAt
    expect(view.origin).toEqual({ lat: -12.05, lon: -77.04 }); // lng→lon
    expect(view.destination).toEqual({ lat: -12.1, lon: -77.0 });
    expect(view.passengerName).toBe('Ana Pérez');
    expect(view.driverName).toBe('Khalid Ríos');
    expect(view.paymentMethod).toBe('YAPE');
    // Datos EN VIVO / no expuestos por GetTrip → null/[] honesto (no data falsa).
    expect(view.driverLocation).toBeNull();
    expect(view.etaSeconds).toBeNull();
    expect(view.vehiclePlate).toBeNull();
    expect(view.timeline).toEqual([]);
  });

  it('origin 0,0 (sin set) → null honesto', async () => {
    const tripGrpc = grpc((m) =>
      m === 'GetTrip'
        ? { id: 't1', passengerId: 'p1', driverId: '', vehicleId: '', status: 'REQUESTED', fareCents: 0, currency: 'PEN', distanceMeters: 0, durationSeconds: 0, paymentMethod: 'CASH', childMode: false, penaltyCents: 0, requestedAt: '2026-06-01T10:00:00.000Z', originLat: 0, originLng: 0, destinationLat: 0, destinationLng: 0, found: true }
        : {},
    );
    const svc = new OpsService(tripGrpc, grpc(() => ({})), noopRest, noopReadModel, noopAudit, config);
    const view = await svc.tripDetail(identity, 't1');
    expect(view.origin).toBeNull();
    expect(view.destination).toBeNull();
    expect(view.driverId).toBeNull();
  });

  it('lanza NotFoundError si el viaje no existe', async () => {
    const tripGrpc = grpc(() => ({ found: false }));
    const svc = new OpsService(tripGrpc, grpc(() => ({})), noopRest, noopReadModel, noopAudit, config);
    await expect(svc.tripDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OpsService.approveDriver', () => {
  it('aprueba vía REST y registra auditoría', async () => {
    const rest = { post: vi.fn().mockResolvedValue({ id: 'd1', backgroundCheckStatus: 'CLEARED' }) } as unknown as InternalRestClient;
    const audit = { record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }) } as unknown as AuditRecorder;
    const svc = new OpsService(grpc(() => ({})), grpc(() => ({})), rest, noopReadModel, audit, config);
    const out = await svc.approveDriver(identity, 'd1');
    expect(out.backgroundCheckStatus).toBe('CLEARED');
    expect(audit.record).toHaveBeenCalledOnce();
  });
});
