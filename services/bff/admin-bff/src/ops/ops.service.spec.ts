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

describe('OpsService.tripDetail (agregador gRPC)', () => {
  it('agrega trip + passenger + driver + rating y deriva payment', async () => {
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
          found: true,
        };
      return {};
    });
    const identityGrpc = grpc((m) => {
      if (m === 'GetUser') return { id: 'p1', type: 'passenger', kycStatus: 'VERIFIED', deleted: false, found: true };
      if (m === 'GetDriver')
        return { id: 'd1', userId: 'u-d1', currentStatus: 'AVAILABLE', backgroundCheckStatus: 'CLEARED', averageRating: 4.8, found: true };
      return {};
    });
    const ratingGrpc = grpc(() => ({
      subjectId: 'd1',
      role: 'DRIVER',
      rollingAvg30d: 4.8,
      count30d: 30,
      flagged: false,
      flagReason: '',
      found: true,
    }));

    const svc = new OpsService(tripGrpc, identityGrpc, ratingGrpc, noopRest, noopReadModel, noopAudit, config);
    const view = await svc.tripDetail(identity, 't1');

    expect(view.trip.status).toBe('COMPLETED');
    expect(view.trip.fareCents).toBe(2500);
    expect(view.passenger).toEqual({ id: 'p1', type: 'passenger', kycStatus: 'VERIFIED' });
    expect(view.driver).toEqual({
      id: 'd1',
      userId: 'u-d1',
      status: 'AVAILABLE',
      backgroundCheckStatus: 'CLEARED',
      averageRating: 4.8,
    });
    expect(view.payment).toEqual({ method: 'YAPE', fareCents: 2500, currency: 'PEN' });
    expect(view.rating).toEqual({ rollingAvg30d: 4.8, count30d: 30, flagged: false, flagReason: null });
  });

  it('lanza NotFoundError si el viaje no existe', async () => {
    const tripGrpc = grpc(() => ({ found: false }));
    const svc = new OpsService(tripGrpc, grpc(() => ({})), grpc(() => ({})), noopRest, noopReadModel, noopAudit, config);
    await expect(svc.tripDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OpsService.approveDriver', () => {
  it('aprueba vía REST y registra auditoría', async () => {
    const rest = { post: vi.fn().mockResolvedValue({ id: 'd1', backgroundCheckStatus: 'CLEARED' }) } as unknown as InternalRestClient;
    const audit = { record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }) } as unknown as AuditRecorder;
    const svc = new OpsService(grpc(() => ({})), grpc(() => ({})), grpc(() => ({})), rest, noopReadModel, audit, config);
    const out = await svc.approveDriver(identity, 'd1');
    expect(out.backgroundCheckStatus).toBe('CLEARED');
    expect(audit.record).toHaveBeenCalledOnce();
  });
});
