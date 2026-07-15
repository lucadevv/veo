/**
 * SEGURIDAD (Ley 29733, FIX 1) — la IP que el AuditController escribe en el log INMUTABLE se resuelve
 * de `req.ip` (poblada por Express vía `trust proxy`), NUNCA del header `x-forwarded-for` crudo
 * (spoofeable). Un atacante que inyecte XFF NO debe poder envenenar el rastro append-only con una IP
 * falsa. Antes, `clientIp()` leía el PRIMER token de XFF crudo y ganaba sobre req.ip: regresión cerrada.
 */
import { describe, it, expect } from 'vitest';
import { AuditController } from './audit.controller';
import type { AuditService, RecordSyncInput } from './audit.service';
import type { RecordedEntry } from './audit.repository';
import type { RecordAuditDto } from './dto/audit.dto';

/** AuditService stub: captura el input y devuelve una entrada que ecoa la IP persistida. */
function fakeAuditService(captured: { input?: RecordSyncInput }): AuditService {
  return {
    recordSync: (input: RecordSyncInput): Promise<RecordedEntry> => {
      captured.input = input;
      const entry: RecordedEntry = {
        id: 'id-1',
        seq: 1n,
        eventId: 'evt-1',
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ip: input.ip,
        userAgent: input.userAgent,
        occurredAt: new Date(0),
        payload: input.payload,
        prevHash: null,
        hash: 'h',
        s3ObjectKey: null,
        createdAt: new Date(0),
      };
      return Promise.resolve(entry);
    },
  } as unknown as AuditService;
}

const dto: RecordAuditDto = {
  action: 'LOGIN',
  resourceType: 'user',
  resourceId: 'u-1',
  payload: {},
} as RecordAuditDto;

const user = { userId: 'actor-1', type: 'admin', roles: [], sessionId: 's-1' } as never;

/** Request mínimo: `ip` es lo que Express resolvió (trust proxy); `headers` lo que mandó el cliente. */
function req(ip: string | undefined, headers: Record<string, string | string[] | undefined>) {
  return { ip, headers, socket: { remoteAddress: '127.0.0.1' } } as never;
}

describe('AuditController · IP del log inmutable (FIX 1)', () => {
  it('SEGURIDAD: persiste req.ip, IGNORANDO el x-forwarded-for inyectado', async () => {
    const captured: { input?: RecordSyncInput } = {};
    const controller = new AuditController(fakeAuditService(captured));
    await controller.record(
      dto,
      user,
      req('203.0.113.7', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }),
    );
    expect(captured.input?.ip).toBe('203.0.113.7'); // la IP REAL
    expect(captured.input?.ip).not.toBe('1.2.3.4'); // NO el primer token del XFF crudo
  });

  it('SEGURIDAD: aun SIN req.ip, NO toma el x-forwarded-for crudo (cae al socket peer)', async () => {
    const captured: { input?: RecordSyncInput } = {};
    const controller = new AuditController(fakeAuditService(captured));
    await controller.record(dto, user, req(undefined, { 'x-forwarded-for': '9.9.9.9' }));
    // El header NO gana: fallback al peer TCP del socket, no a la IP forjada.
    expect(captured.input?.ip).toBe('127.0.0.1');
    expect(captured.input?.ip).not.toBe('9.9.9.9');
  });

  it('rotar el x-forwarded-for NO cambia la IP auditada (misma req.ip)', async () => {
    const captured: { input?: RecordSyncInput } = {};
    const controller = new AuditController(fakeAuditService(captured));
    await controller.record(dto, user, req('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' }));
    const first = captured.input?.ip;
    await controller.record(dto, user, req('203.0.113.7', { 'x-forwarded-for': '2.2.2.2' }));
    expect(captured.input?.ip).toBe(first);
    expect(captured.input?.ip).toBe('203.0.113.7');
  });
});
