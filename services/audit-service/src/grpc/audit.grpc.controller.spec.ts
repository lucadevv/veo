/**
 * Spec del controlador gRPC de audit — foco en la INTEGRIDAD del WORM inmutable (Ley 29733):
 *   1) el `actorId` que se persiste se DERIVA de la identidad VERIFICADA (firma HMAC), NUNCA del body
 *      → un `actor_id` forjado en el request se IGNORA y se escribe el de la identidad.
 *   2) firma ausente/inválida → UNAUTHENTICATED (no escribe al WORM).
 *   3) firma válida pero de un riel no autorizado (≠ admin-rail) → PERMISSION_DENIED (mínimo privilegio).
 * El único caller legítimo del gRPC Record es el admin-bff (AuditRecorder), que firma con `admin-rail`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  grpcIdentityMetadata,
  InternalAudience,
  type AuthenticatedUser,
  type InternalAudience as InternalAudienceType,
} from '@veo/auth';
import { AuditGrpcController } from './audit.grpc.controller';
import type { AuditService } from '../audit/audit.service';
import type { RecordedEntry } from '../audit/audit.repository';
import type { Env } from '../config/env.schema';

const INTERNAL_IDENTITY_SECRET = 's'.repeat(32);

/** Operador real detrás del admin-bff: ESTA es la identidad que debe quedar en el WORM. */
const OPERATOR: AuthenticatedUser = {
  userId: 'op-real-001',
  type: 'admin',
  roles: ['COMPLIANCE_SUPERVISOR'],
  sessionId: 'sess-op',
};

/** Metadata gRPC entrante FIRMADA con el riel `aud` indicado. */
function signedMetaAs(aud: InternalAudienceType): Metadata {
  const meta = new Metadata();
  const headers = grpcIdentityMetadata(OPERATOR, INTERNAL_IDENTITY_SECRET, aud);
  for (const [k, v] of Object.entries(headers)) meta.set(k, v);
  return meta;
}

const FAKE_ENTRY: RecordedEntry = {
  id: 'entry-1',
  seq: 42n,
  eventId: 'evt-1',
  actorId: OPERATOR.userId,
  action: 'operator.create',
  resourceType: 'operator',
  resourceId: 'op-new',
  ip: '',
  userAgent: 'grpc',
  occurredAt: new Date('2026-06-26T00:00:00.000Z'),
  payload: {},
  prevHash: null,
  hash: 'h1',
  s3ObjectKey: null,
  createdAt: new Date('2026-06-26T00:00:00.000Z'),
};

function makeController(): {
  ctrl: AuditGrpcController;
  recordSync: ReturnType<typeof vi.fn>;
  verifyRange: ReturnType<typeof vi.fn>;
} {
  const recordSync = vi.fn(async () => FAKE_ENTRY);
  const verifyRange = vi.fn(async () => ({
    valid: true,
    checked: 1,
    brokenAtSeq: undefined,
    reason: undefined,
    fromSeq: '1',
    toSeq: '1',
  }));
  const audit = { recordSync, verifyRange } as unknown as AuditService;
  const config = new ConfigService<Env, true>({
    INTERNAL_IDENTITY_SECRET,
  } as unknown as Env);
  return { ctrl: new AuditGrpcController(audit, config), recordSync, verifyRange };
}

/** Extrae el `code` del error gRPC envuelto en RpcException. */
function grpcCodeOf(err: unknown): number | undefined {
  if (err instanceof RpcException) {
    const e = err.getError();
    if (typeof e === 'object' && e !== null && 'code' in e) {
      return (e as { code: number }).code;
    }
  }
  return undefined;
}

describe('AuditGrpcController · integridad del actorId del WORM (anti-spoof)', () => {
  it('Record · admin-rail · DERIVA actorId de la identidad e IGNORA el actor_id forjado del body', async () => {
    const { ctrl, recordSync } = makeController();
    const reply = await ctrl.record(
      {
        actorId: 'forged-superadmin', // ← intento de forja: NO debe llegar al WORM
        action: 'operator.create',
        resourceType: 'operator',
        resourceId: 'op-new',
        payloadJson: '{"email":"x@y.z"}',
      },
      signedMetaAs(InternalAudience.ADMIN_RAIL),
    );
    expect(recordSync).toHaveBeenCalledTimes(1);
    const persisted = recordSync.mock.calls[0]![0] as { actorId: string };
    // ASSERT CLAVE: se persiste la identidad VERIFICADA, no el actorId forjado del body.
    expect(persisted.actorId).toBe(OPERATOR.userId);
    expect(persisted.actorId).not.toBe('forged-superadmin');
    expect(reply.id).toBe('entry-1');
    expect(reply.seq).toBe('42');
  });

  it('Record · firma ausente → UNAUTHENTICATED (no escribe al WORM)', async () => {
    const { ctrl, recordSync } = makeController();
    let caught: unknown;
    try {
      await ctrl.record(
        { actorId: 'x', action: 'a', resourceType: 'r', resourceId: 'i', payloadJson: '{}' },
        new Metadata(),
      );
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(recordSync).not.toHaveBeenCalled();
  });

  it('Record · firma válida pero riel equivocado (service-rail) → PERMISSION_DENIED', async () => {
    const { ctrl, recordSync } = makeController();
    let caught: unknown;
    try {
      await ctrl.record(
        { actorId: 'x', action: 'a', resourceType: 'r', resourceId: 'i', payloadJson: '{}' },
        signedMetaAs(InternalAudience.SERVICE_RAIL),
      );
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(recordSync).not.toHaveBeenCalled();
  });

  it('Record · firma válida pero riel equivocado (driver-rail) → PERMISSION_DENIED', async () => {
    const { ctrl, recordSync } = makeController();
    let caught: unknown;
    try {
      await ctrl.record(
        { actorId: 'x', action: 'a', resourceType: 'r', resourceId: 'i', payloadJson: '{}' },
        signedMetaAs(InternalAudience.DRIVER_RAIL),
      );
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(recordSync).not.toHaveBeenCalled();
  });
});

describe('AuditGrpcController · Verify gateado por identidad firmada', () => {
  it('Verify · admin-rail → ejecuta la verificación de integridad', async () => {
    const { ctrl, verifyRange } = makeController();
    const reply = await ctrl.verify({ fromSeq: '', toSeq: '' }, signedMetaAs(InternalAudience.ADMIN_RAIL));
    expect(verifyRange).toHaveBeenCalledTimes(1);
    expect(reply.valid).toBe(true);
    expect(reply.checked).toBe(1);
  });

  it('Verify · firma ausente → UNAUTHENTICATED', async () => {
    const { ctrl, verifyRange } = makeController();
    let caught: unknown;
    try {
      await ctrl.verify({ fromSeq: '', toSeq: '' }, new Metadata());
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.UNAUTHENTICATED);
    expect(verifyRange).not.toHaveBeenCalled();
  });

  it('Verify · riel equivocado (service-rail) → PERMISSION_DENIED', async () => {
    const { ctrl, verifyRange } = makeController();
    let caught: unknown;
    try {
      await ctrl.verify({ fromSeq: '', toSeq: '' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(verifyRange).not.toHaveBeenCalled();
  });
});
