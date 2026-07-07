import { describe, it, expect, vi } from 'vitest';
import { SecurityService } from './security.service';
import type { InternalRestClient, GrpcServiceClient } from '@veo/rpc';
import type { ConfigService } from '@nestjs/config';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';

const identity: AuthenticatedUser = {
  userId: 'sec1',
  type: 'admin',
  roles: ['SUPPORT_L2'],
  sessionId: 's1',
};
const config = { get: () => 'internal-secret' } as unknown as ConfigService<Env, true>;

/** identity gRPC que enriquece nombres: GetUser → pasajero, GetDriver → conductor. */
const identityGrpc = {
  call: vi.fn((method: string) =>
    Promise.resolve(
      method === 'GetUser'
        ? { name: 'Ana Pérez', found: true }
        : method === 'GetDriver'
          ? { name: 'Khalid Ríos', found: true }
          : {},
    ),
  ),
} as unknown as GrpcServiceClient;
/** trip gRPC que resuelve el driverId del viaje (PanicEntity no lo trae). */
const tripGrpc = {
  call: vi.fn(() => Promise.resolve({ driverId: 'drv-1', found: true })),
} as unknown as GrpcServiceClient;

const panicEntity = {
  id: 'pa1',
  tripId: 't1',
  passengerId: 'p1',
  triggeredAt: '2026-05-29T00:00:00.000Z',
  geoPoint: { lat: -12.05, lon: -77.04 },
  dedupKey: 'k1',
  status: 'TRIGGERED',
  evidenceS3Keys: ['s3://a'],
};

describe('SecurityService', () => {
  it('mapea PanicEntity → panicSummary (geoPoint → geo, acknowledgedAt nullable)', async () => {
    const rest = { get: vi.fn().mockResolvedValue([panicEntity]) } as unknown as InternalRestClient;
    const audit = { record: vi.fn() } as unknown as AuditRecorder;
    const svc = new SecurityService(
      rest,
      identityGrpc,
      tripGrpc,
      InternalAudience.ADMIN_RAIL,
      audit,
      config,
    );
    const page = await svc.listPanics(identity, {});
    // El contrato admin es paginado: { items, nextCursor } (panic-service devuelve array → nextCursor null).
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      id: 'pa1',
      tripId: 't1',
      passengerId: 'p1',
      status: 'TRIGGERED',
      geo: { lat: -12.05, lon: -77.04 },
      triggeredAt: '2026-05-29T00:00:00.000Z',
      acknowledgedAt: null,
    });
  });

  it('ack registra auditoría y mapea al contrato panicDetail (ackBy → acknowledgedBy, evidence)', async () => {
    const rest = {
      post: vi.fn().mockResolvedValue({
        ...panicEntity,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: 'x',
        ackBy: 'sec1',
        evidenceS3Keys: ['panic/t1/clip.mp4'],
      }),
    } as unknown as InternalRestClient;
    const audit = {
      record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }),
    } as unknown as AuditRecorder;
    const svc = new SecurityService(
      rest,
      identityGrpc,
      tripGrpc,
      InternalAudience.ADMIN_RAIL,
      audit,
      config,
    );
    // Actor COMPLIANCE_SUPERVISOR: este test verifica ENRIQUECIMIENTO+mapeo, no redacción → debe ver
    // los nombres. (La redacción sub-Compliance se cubre en su propio test).
    const compliance: AuthenticatedUser = { ...identity, roles: ['COMPLIANCE_SUPERVISOR'] };
    const out = await svc.ack(compliance, 'pa1');
    expect(out.status).toBe('ACKNOWLEDGED');
    expect(out.acknowledgedBy).toBe('sec1');
    // ENRIQUECIDO: nombres reales de identity (security: quién está en peligro / quién maneja) + driverId del viaje.
    expect(out.passengerName).toBe('Ana Pérez');
    expect(out.driverId).toBe('drv-1');
    expect(out.driverName).toBe('Khalid Ríos');
    // evidence mapeado desde el S3 key.
    expect(out.evidence).toEqual([
      { id: 'panic/t1/clip.mp4', kind: 'video', label: 'clip.mp4', at: panicEntity.triggeredAt },
    ]);
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('SUPPORT_L2 (sub-Compliance): redacta nombres a null pero la GEO del pánico STAYS EXACTA', async () => {
    const rest = {
      get: vi.fn().mockResolvedValue({ ...panicEntity, status: 'TRIGGERED' }),
    } as unknown as InternalRestClient;
    const audit = { record: vi.fn() } as unknown as AuditRecorder;
    const svc = new SecurityService(
      rest,
      identityGrpc,
      tripGrpc,
      InternalAudience.ADMIN_RAIL,
      audit,
      config,
    );
    // identity por defecto ya es SUPPORT_L2 (sub-Compliance).
    const out = await svc.getPanic(identity, 'pa1');
    // IDENTIDAD → null (Compliance+)
    expect(out.passengerName).toBeNull();
    expect(out.driverName).toBeNull();
    // driverId NO es identidad personal (es un id opaco) → se preserva.
    expect(out.driverId).toBe('drv-1');
    // GEO de emergencia → EXACTA para todo el que pueda ver pánicos (sin redacción).
    expect(out.geo).toEqual({ lat: -12.05, lon: -77.04 });
  });

  it('COMPLIANCE_SUPERVISOR: ve nombres reales sin redactar', async () => {
    const rest = {
      get: vi.fn().mockResolvedValue({ ...panicEntity, status: 'TRIGGERED' }),
    } as unknown as InternalRestClient;
    const audit = { record: vi.fn() } as unknown as AuditRecorder;
    const svc = new SecurityService(
      rest,
      identityGrpc,
      tripGrpc,
      InternalAudience.ADMIN_RAIL,
      audit,
      config,
    );
    const compliance: AuthenticatedUser = { ...identity, roles: ['COMPLIANCE_SUPERVISOR'] };
    const out = await svc.getPanic(compliance, 'pa1');
    expect(out.passengerName).toBe('Ana Pérez');
    expect(out.driverName).toBe('Khalid Ríos');
  });
});
