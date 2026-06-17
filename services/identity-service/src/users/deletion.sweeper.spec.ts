/**
 * Unit del DeletionSweeper — derecho al olvido (BR-S06 · Ley 29733).
 * Verifica que al vencer la gracia el barrido: anula la PII de contacto, PURGA la biometría
 * (User.faceEmbedding, Driver.faceEmbedding y los intentos de BiometricCheck) y encola la señal de
 * cascada `user.deleted` en el outbox DENTRO de la misma transacción. Sin DB real (doble de Prisma).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@veo/events';
import { DeletionSweeper } from './deletion.sweeper';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ DELETION_GRACE_DAYS: 30 });

interface TxCalls {
  userUpdate: ReturnType<typeof vi.fn>;
  driverUpdate: ReturnType<typeof vi.fn>;
  biometricUpdateMany: ReturnType<typeof vi.fn>;
  outboxCreate: ReturnType<typeof vi.fn>;
}

/** Doble de PrismaService: `read.user.findMany` devuelve los vencidos; `write.$transaction` graba. */
function makePrisma(due: { id: string; driver: { id: string } | null }[]): {
  prisma: { read: unknown; write: unknown };
  calls: TxCalls;
} {
  const calls: TxCalls = {
    userUpdate: vi.fn(async () => ({})),
    driverUpdate: vi.fn(async () => ({})),
    biometricUpdateMany: vi.fn(async () => ({ count: 0 })),
    outboxCreate: vi.fn(async () => ({})),
  };
  const tx = {
    user: { update: calls.userUpdate },
    driver: { update: calls.driverUpdate },
    biometricCheck: { updateMany: calls.biometricUpdateMany },
    outboxEvent: { create: calls.outboxCreate },
  };
  const prisma = {
    read: { user: { findMany: vi.fn(async () => due) } },
    write: { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
  };
  return { prisma, calls };
}

describe('DeletionSweeper.sweep · purga de PII + biometría + cascada (BR-S06)', () => {
  it('anula la PII de contacto Y la biometría del User (faceEmbedding → [])', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    const n = await sweeper.sweep();

    expect(n).toBe(1);
    const data = calls.userUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.email).toBeNull();
    expect(data.dniHash).toBeNull();
    expect(data.photoUrl).toBeNull();
    expect(data.phone).toBe('[deleted:phone:u1]');
    expect(data.faceEmbedding).toEqual([]); // biometría purgada
  });

  it('purga el faceEmbedding del Driver cuando el usuario es conductor', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: { id: 'd1' } }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    await sweeper.sweep();

    expect(calls.driverUpdate).toHaveBeenCalledTimes(1);
    expect(calls.driverUpdate.mock.calls[0]![0]).toEqual({
      where: { id: 'd1' },
      data: { faceEmbedding: [] },
    });
  });

  it('no toca driver si el usuario es solo pasajero', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    await sweeper.sweep();
    expect(calls.driverUpdate).not.toHaveBeenCalled();
  });

  it('anonimiza los intentos de BiometricCheck del usuario (score/geo/captureRef)', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    await sweeper.sweep();

    expect(calls.biometricUpdateMany).toHaveBeenCalledTimes(1);
    expect(calls.biometricUpdateMany.mock.calls[0]![0]).toEqual({
      where: { userId: 'u1' },
      data: { score: 0, geoLat: null, geoLon: null, captureRef: null },
    });
  });

  it('encola user.deleted en el outbox (misma tx) con el payload de cascada', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: { id: 'd1' } }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    await sweeper.sweep();

    expect(calls.outboxCreate).toHaveBeenCalledTimes(1);
    const arg = calls.outboxCreate.mock.calls[0]![0] as {
      data: {
        aggregateId: string;
        eventType: string;
        envelope: EventEnvelope<{ userId: string; driverId?: string; at: string }>;
      };
    };
    expect(arg.data.aggregateId).toBe('u1');
    expect(arg.data.eventType).toBe('user.deleted');
    const env = arg.data.envelope;
    expect(env.producer).toBe('identity-service');
    expect(env.payload.userId).toBe('u1');
    expect(env.payload.driverId).toBe('d1');
    expect(typeof env.payload.at).toBe('string');
  });

  it('omite driverId en el payload cuando no hay conductor', async () => {
    const { prisma, calls } = makePrisma([{ id: 'u1', driver: null }]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    await sweeper.sweep();
    const env = (
      calls.outboxCreate.mock.calls[0]![0] as {
        data: { envelope: EventEnvelope<{ driverId?: string }> };
      }
    ).data.envelope;
    expect(env.payload.driverId).toBeUndefined();
  });

  it('es idempotente: sin cuentas vencidas no escribe nada', async () => {
    const { prisma, calls } = makePrisma([]);
    const sweeper = new DeletionSweeper(prisma as never, config);
    const n = await sweeper.sweep();
    expect(n).toBe(0);
    expect(calls.userUpdate).not.toHaveBeenCalled();
    expect(calls.outboxCreate).not.toHaveBeenCalled();
  });
});
