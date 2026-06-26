/**
 * Spec del AuditRecorder — foco en la IDEMPOTENCIA del registro síncrono:
 * el recorder genera un `eventId` ESTABLE (UUIDv7) por record() y lo manda en el request gRPC, para que
 * un retry de TRANSPORTE del mismo record() dedupee en el WORM (no duplique la fila). Espeja recordFromEvent.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { isUuidV7 } from '@veo/utils';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, RecordReply } from '@veo/rpc';
import { AuditRecorder } from './audit-recorder.service';
import type { Env } from '../config/env.schema';

const OPERATOR: AuthenticatedUser = {
  userId: 'op-real-001',
  type: 'admin',
  roles: ['COMPLIANCE_SUPERVISOR'],
  sessionId: 'sess-op',
};

function makeRecorder(): { recorder: AuditRecorder; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (): Promise<RecordReply> => ({ id: 'e1', seq: '1', hash: 'h1' }));
  const grpc = { call } as unknown as GrpcServiceClient;
  const config = new ConfigService<Env, true>({
    VEO_INTERNAL_IDENTITY_SECRET: 's'.repeat(32),
  } as unknown as Env);
  const recorder = new AuditRecorder(grpc, InternalAudience.ADMIN_RAIL, config);
  return { recorder, call };
}

describe('AuditRecorder · eventId estable para idempotencia', () => {
  it('manda un eventId NO vacío y UUIDv7 válido en el request gRPC', async () => {
    const { recorder, call } = makeRecorder();
    await recorder.record(OPERATOR, {
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new',
      payload: { email: 'x@y.z' },
    });
    expect(call).toHaveBeenCalledTimes(1);
    const request = call.mock.calls[0]![1] as { eventId?: string };
    expect(request.eventId).toBeTruthy();
    expect(isUuidV7(request.eventId!)).toBe(true);
  });

  it('genera un eventId DISTINTO por cada record() (operaciones distintas no se dedupean)', async () => {
    const { recorder, call } = makeRecorder();
    const action = { action: 'operator.create', resourceType: 'operator', resourceId: 'op-new' };
    await recorder.record(OPERATOR, action);
    await recorder.record(OPERATOR, action);
    const first = (call.mock.calls[0]![1] as { eventId: string }).eventId;
    const second = (call.mock.calls[1]![1] as { eventId: string }).eventId;
    expect(first).not.toBe(second);
  });
});
