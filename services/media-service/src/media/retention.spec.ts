import { describe, it, expect } from 'vitest';
import { computeRetentionUntil, isExpired } from './retention';
import { RetentionSweeper } from './retention.sweeper';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';

const startedAt = new Date('2026-05-01T00:00:00.000Z');
const base = { startedAt, defaultDays: 30, incidentDays: 180 };

describe('computeRetentionUntil · política de retención (BR-S03)', () => {
  it('por defecto retiene 30 días', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: false, hasPanic: false });
    expect(until).toEqual(new Date('2026-05-31T00:00:00.000Z'));
  });

  it('con incidente retiene 180 días', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: true, hasPanic: false });
    expect(until).toEqual(new Date('2026-10-28T00:00:00.000Z'));
  });

  it('con pánico la retención es indefinida (null)', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: false, hasPanic: true });
    expect(until).toBeNull();
  });

  it('el pánico prevalece sobre el incidente (indefinido)', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: true, hasPanic: true });
    expect(until).toBeNull();
  });
});

describe('isExpired', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');
  it('expira si la fecha de retención ya pasó', () => {
    expect(isExpired(new Date('2026-06-01T00:00:00.000Z'), now)).toBe(true);
  });
  it('no expira si la retención es futura', () => {
    expect(isExpired(new Date('2026-07-01T00:00:00.000Z'), now)).toBe(false);
  });
  it('nunca expira con retención indefinida (null = pánico)', () => {
    expect(isExpired(null, now)).toBe(false);
  });
});

describe('RetentionSweeper.sweep · barrido de ciclo de vida (BR-S03)', () => {
  function makePrisma(segments: { id: string; s3Key: string; retentionUntil: Date | null }[]) {
    const deleted: string[] = [];
    const prisma = {
      read: {
        mediaSegment: {
          findMany: async ({ where }: { where: { retentionUntil: { lte: Date } } }) =>
            segments.filter(
              (s) => s.retentionUntil !== null && s.retentionUntil.getTime() <= where.retentionUntil.lte.getTime(),
            ),
        },
      },
      write: {
        mediaSegment: {
          delete: async ({ where }: { where: { id: string } }) => {
            deleted.push(where.id);
            return {};
          },
        },
      },
    };
    return { prisma, deleted };
  }

  it('borra solo los segmentos vencidos y respeta los indefinidos y futuros', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const segments = [
      { id: 'expired', s3Key: 'recordings/t1/expired.mp4', retentionUntil: new Date('2026-06-01T00:00:00.000Z') },
      { id: 'future', s3Key: 'recordings/t2/future.mp4', retentionUntil: new Date('2026-07-01T00:00:00.000Z') },
      { id: 'panic', s3Key: 'recordings/t3/panic.mp4', retentionUntil: null },
    ];
    const { prisma, deleted } = makePrisma(segments);
    const sweeper = new RetentionSweeper(prisma as never, new StorageSandboxAdapter());

    const purged = await sweeper.sweep(now);

    expect(purged).toBe(1);
    expect(deleted).toEqual(['expired']);
  });
});
