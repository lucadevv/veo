/**
 * Unit del DeletionSweeper — derecho al olvido (BR-S06 · Ley 29733).
 * Verifica que al vencer la gracia el barrido: anula la PII de contacto, PURGA la biometría
 * (User.faceEmbedding, Driver.faceEmbedding y los intentos de BiometricCheck) y encola la señal de
 * cascada `user.deleted` en el outbox DENTRO de la misma transacción. Sin DB real: el sweeper ORQUESTA
 * la política del olvido, el acceso Prisma vive en UsersRepository (§10) — se mockea el repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@veo/events';
import { DeletionSweeper } from './deletion.sweeper';
import type { UsersRepository, UsersTx } from './users.repository';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ DELETION_GRACE_DAYS: 30 });

/** Doble del RedisRefreshTokenStore: solo se ejercita `revokeAllForUser` (revoke en borrado de cuenta). */
const sessions = { revokeAllForUser: vi.fn(async () => 1) };

beforeEach(() => {
  sessions.revokeAllForUser.mockClear();
});

/** Token opaco de transacción: el sweeper lo forwardea a los métodos tx del repo, no lo dereferencia. */
const TX = {} as UsersTx;

interface RepoCalls {
  updateUserTx: ReturnType<typeof vi.fn>;
  updateDriverTx: ReturnType<typeof vi.fn>;
  anonymizeBiometricChecksTx: ReturnType<typeof vi.fn>;
  enqueueOutbox: ReturnType<typeof vi.fn>;
}

/**
 * Doble de UsersRepository: `findUsersDueForDeletion` devuelve los vencidos; `runInTransaction` corre el
 * cuerpo con un tx opaco; los métodos tx graban las llamadas para verificar QUÉ PII se anula.
 */
function makeRepo(due: { id: string; driver: { id: string } | null }[]): {
  repo: UsersRepository;
  calls: RepoCalls;
} {
  const calls: RepoCalls = {
    updateUserTx: vi.fn(async () => undefined),
    updateDriverTx: vi.fn(async () => undefined),
    anonymizeBiometricChecksTx: vi.fn(async () => undefined),
    enqueueOutbox: vi.fn(async () => undefined),
  };
  const repo = {
    findUsersDueForDeletion: vi.fn(async () => due),
    runInTransaction: vi.fn(async (work: (tx: UsersTx) => Promise<unknown>) => work(TX)),
    ...calls,
  } as unknown as UsersRepository;
  return { repo, calls };
}

describe('DeletionSweeper.sweep · purga de PII + biometría + cascada (BR-S06)', () => {
  it('anula la PII de contacto Y la biometría del User (faceEmbedding → [])', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    const n = await sweeper.sweep();

    expect(n).toBe(1);
    const [tx, userId, data] = calls.updateUserTx.mock.calls[0] as [
      UsersTx,
      string,
      Record<string, unknown>,
    ];
    expect(tx).toBe(TX);
    expect(userId).toBe('u1');
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.email).toBeNull();
    expect(data.dniHash).toBeNull();
    expect(data.photoUrl).toBeNull();
    expect(data.phone).toBe('[deleted:phone:u1]');
    expect(data.faceEmbedding).toEqual([]); // biometría purgada
  });

  it('purga el faceEmbedding del Driver cuando el usuario es conductor', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: { id: 'd1' } }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();

    expect(calls.updateDriverTx).toHaveBeenCalledTimes(1);
    // Vacía el embedding Y resetea el binding DNI↔selfie (invariante de frescura: mutar el material cotejado
    // invalida el binding; además no dejamos evidencia biométrica stale de una cuenta borrada).
    const [tx, driverId, data] = calls.updateDriverTx.mock.calls[0] as [UsersTx, string, unknown];
    expect(tx).toBe(TX);
    expect(driverId).toBe('d1');
    expect(data).toEqual({
      faceEmbedding: [],
      dniFaceMatched: null,
      dniFaceMatchScore: null,
      dniFaceMatchedAt: null,
    });
  });

  it('no toca driver si el usuario es solo pasajero', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();
    expect(calls.updateDriverTx).not.toHaveBeenCalled();
  });

  it('anonimiza los intentos de BiometricCheck del usuario (score/geo/captureRef)', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();

    expect(calls.anonymizeBiometricChecksTx).toHaveBeenCalledTimes(1);
    const [tx, userId, data] = calls.anonymizeBiometricChecksTx.mock.calls[0] as [
      UsersTx,
      string,
      unknown,
    ];
    expect(tx).toBe(TX);
    expect(userId).toBe('u1');
    expect(data).toEqual({ score: 0, geoLat: null, geoLon: null, captureRef: null });
  });

  it('encola user.deleted en el outbox (misma tx) con el payload de cascada', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: { id: 'd1' } }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();

    expect(calls.enqueueOutbox).toHaveBeenCalledTimes(1);
    const [tx, envelope, aggregateId] = calls.enqueueOutbox.mock.calls[0] as [
      UsersTx,
      EventEnvelope<{ userId: string; driverId?: string; at: string }>,
      string,
    ];
    expect(tx).toBe(TX);
    expect(aggregateId).toBe('u1');
    expect(envelope.eventType).toBe('user.deleted');
    expect(envelope.producer).toBe('identity-service');
    expect(envelope.payload.userId).toBe('u1');
    expect(envelope.payload.driverId).toBe('d1');
    expect(typeof envelope.payload.at).toBe('string');
  });

  it('omite driverId en el payload cuando no hay conductor', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();
    const [, envelope] = calls.enqueueOutbox.mock.calls[0] as [
      UsersTx,
      EventEnvelope<{ driverId?: string }>,
      string,
    ];
    expect(envelope.payload.driverId).toBeUndefined();
  });

  it('es idempotente: sin cuentas vencidas no escribe nada', async () => {
    const { repo, calls } = makeRepo([]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    const n = await sweeper.sweep();
    expect(n).toBe(0);
    expect(calls.updateUserTx).not.toHaveBeenCalled();
    expect(calls.enqueueOutbox).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('revoca TODAS las sesiones de cada cuenta tombstoneada (ADR-012 §2: revoke en borrado)', async () => {
    const { repo } = makeRepo([
      { id: 'u1', driver: null },
      { id: 'u2', driver: { id: 'd2' } },
    ]);
    const sweeper = new DeletionSweeper(repo, config, sessions as never);
    await sweeper.sweep();

    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(2);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u2');
  });

  it('fail-OPEN: si el revoke de sesiones falla, el tombstone NO se revierte (PII ya anonimizada)', async () => {
    const { repo, calls } = makeRepo([{ id: 'u1', driver: null }]);
    sessions.revokeAllForUser.mockRejectedValueOnce(new Error('Redis down'));
    const sweeper = new DeletionSweeper(repo, config, sessions as never);

    const n = await sweeper.sweep();

    // El barrido cuenta la cuenta como aplicada aunque el revoke best-effort haya fallado.
    expect(n).toBe(1);
    expect(calls.updateUserTx).toHaveBeenCalledTimes(1);
    expect(calls.enqueueOutbox).toHaveBeenCalledTimes(1);
  });
});
