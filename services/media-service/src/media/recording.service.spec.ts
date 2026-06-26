import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RecordingService, roomNameForTrip } from './recording.service';
import { LiveKitSandboxAdapter } from '../ports/livekit/livekit.module';
import type { IssueTokenInput, LiveKitPort } from '../ports/livekit/livekit.port';
import type { StoragePort } from '../ports/storage/storage.port';
import type { Env } from '../config/env.schema';

/** Adapter LiveKit espía: captura el último IssueTokenInput para aseverar los grants emitidos. */
function makeSpyLivekit(): { livekit: LiveKitPort; captured: { input?: IssueTokenInput } } {
  const captured: { input?: IssueTokenInput } = {};
  const livekit: LiveKitPort = {
    issueAccessToken: async (input) => {
      captured.input = input;
      return 'spy-token';
    },
    startRecording: async () => ({ egressId: 'spy-egress' }),
    stopRecording: async () => ({ bytes: 0 }),
  };
  return { livekit, captured };
}

const config = new ConfigService<Env, true>({
  LIVEKIT_TOKEN_TTL_SECONDS: 3600,
  KMS_KEY_ID_VIDEO: 'alias/veo-video',
  RETENTION_DEFAULT_DAYS: 30,
  RETENTION_INCIDENT_DAYS: 180,
  LIVEKIT_URL: 'ws://localhost:7880',
});

interface Seg {
  id: string;
  tripId: string;
  startedAt: Date;
  endedAt: Date | null;
  s3Key: string;
  egressId: string | null;
  hasIncident: boolean;
  hasPanic: boolean;
  retentionUntil: Date | null;
  sizeBytes?: bigint;
}

function makePrisma() {
  const segments: Seg[] = [];
  const accessRequests: { tripId: string }[] = [];
  const outbox: { eventType: string }[] = [];
  const tx = {
    mediaSegment: {
      create: async ({
        data,
      }: {
        data: Partial<Seg> & { id: string; tripId: string; startedAt: Date; s3Key: string };
      }) => {
        const seg: Seg = {
          endedAt: null,
          egressId: null,
          hasIncident: false,
          hasPanic: false,
          retentionUntil: null,
          ...data,
        };
        segments.push(seg);
        return seg;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Seg> }) => {
        const s = segments.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        let count = 0;
        for (let i = segments.length - 1; i >= 0; i--) {
          if (ids.has(segments[i]!.id)) {
            segments.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    videoAccessRequest: {
      deleteMany: async ({ where }: { where: { tripId: string } }) => {
        let count = 0;
        for (let i = accessRequests.length - 1; i >= 0; i--) {
          if (accessRequests[i]!.tripId === where.tripId) {
            accessRequests.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { envelope: { eventType: string } } }) => {
        outbox.push({ eventType: data.envelope.eventType });
        return {};
      },
    },
  };
  const prisma = {
    read: {
      mediaSegment: {
        findFirst: async ({ where }: { where: { tripId: string; endedAt: null } }) =>
          segments
            .filter((s) => s.tripId === where.tripId && s.endedAt === null)
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null,
        findMany: async ({ where }: { where: { tripId: string } }) =>
          segments
            .filter((s) => s.tripId === where.tripId)
            .map((s) => ({ id: s.id, s3Key: s.s3Key })),
      },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      mediaSegment: tx.mediaSegment,
    },
  };
  return { prisma, segments, accessRequests, outbox };
}

/** Storage espía que registra cada deleteObject (key). */
function makeSpyStorage(): { storage: StoragePort; deletes: string[] } {
  const deletes: string[] = [];
  const storage: StoragePort = {
    presignDownloadUrl: async () => 'url',
    presignUploadUrl: async () => 'url',
    deleteObject: async (key: string) => {
      deletes.push(key);
    },
    getObjectSize: async () => 0,
    deletePrefix: async () => 0,
    getObjectStream: async () => {
      throw new Error('getObjectStream no usado en este test');
    },
    uploadObject: async () => {},
  };
  return { storage, deletes };
}

describe('RecordingService.issueRoomToken · token de cámara (BR-S01)', () => {
  it('emite un token para la room del viaje', async () => {
    const { prisma } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    const res = await svc.issueRoomToken({ tripId: 'trip-1', identity: 'user-1' });
    expect(res.roomName).toBe(roomNameForTrip('trip-1'));
    expect(res.token).toContain('trip-1');
    expect(res.expiresInSeconds).toBe(3600);
  });
});

describe('RecordingService.issueViewerToken · espectador PURO del muro admin', () => {
  it('mintea SOLO-SUSCRIPCIÓN en la sala donde publica el conductor (canPublish/Data:false)', async () => {
    const { prisma } = makePrisma();
    const { livekit, captured } = makeSpyLivekit();
    const svc = new RecordingService(prisma as never, livekit, makeSpyStorage().storage, config);

    const res = await svc.issueViewerToken({ tripId: 'trip-1', identity: 'admin-7' });

    // MISMA sala que el conductor (si divergiera, el admin vería una sala vacía — el bug que arreglamos).
    expect(res.roomName).toBe(roomNameForTrip('trip-1'));
    expect(captured.input?.canSubscribe).toBe(true);
    // Espectador puro: jamás publica audio/video NI datos en la cabina.
    expect(captured.input?.canPublish).toBe(false);
    expect(captured.input?.canPublishData).toBe(false);
    expect(captured.input?.identity).toBe('admin-7');
  });
});

describe('RecordingService.startForTrip · inicio automático (BR-S01)', () => {
  it('crea un segmento con retención por defecto y emite media.recording_started', async () => {
    const { prisma, segments, outbox } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    const startedAt = new Date('2026-05-28T20:00:00.000Z');

    const res = await svc.startForTrip('trip-1', startedAt);

    expect(res.created).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.retentionUntil).toEqual(new Date('2026-06-27T20:00:00.000Z')); // +30d
    expect(outbox).toEqual([{ eventType: 'media.recording_started' }]);
  });

  it('es idempotente: no duplica la grabación si ya hay una en curso', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    const startedAt = new Date('2026-05-28T20:00:00.000Z');
    await svc.startForTrip('trip-1', startedAt);
    const second = await svc.startForTrip('trip-1', startedAt);
    expect(second.created).toBe(false);
    expect(segments).toHaveLength(1);
  });
});

describe('RecordingService.onPanic · force-start y retención indefinida (BR-S01/S03)', () => {
  it('fuerza el inicio de grabación si no había ninguna (viaje en ARRIVING)', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );

    const res = await svc.onPanic('trip-9', new Date('2026-05-28T21:00:00.000Z'));

    expect(res.forced).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.hasPanic).toBe(true);
    expect(segments[0]?.retentionUntil).toBeNull(); // indefinido
  });

  it('si ya grababa, solo escala la retención a indefinida', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));

    const res = await svc.onPanic('trip-1', new Date('2026-05-28T20:10:00.000Z'));

    expect(res.forced).toBe(false);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.hasPanic).toBe(true);
    expect(segments[0]?.retentionUntil).toBeNull();
  });
});

describe('RecordingService.finishForTrip · archivado (BR-S01)', () => {
  it('finaliza el segmento abierto y emite media.archived', async () => {
    const { prisma, segments, outbox } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));

    const res = await svc.finishForTrip('trip-1', new Date('2026-05-28T20:30:00.000Z'));

    expect(res.archived).toBe(true);
    expect(segments[0]?.endedAt).toEqual(new Date('2026-05-28T20:30:00.000Z'));
    expect(segments[0]?.sizeBytes).toBe(BigInt(1_048_576));
    expect(outbox.map((o) => o.eventType)).toContain('media.archived');
  });

  it('no hace nada si no hay segmento abierto', async () => {
    const { prisma } = makePrisma();
    const svc = new RecordingService(
      prisma as never,
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
    );
    const res = await svc.finishForTrip('trip-empty', new Date());
    expect(res.archived).toBe(false);
  });
});

describe('RecordingService.eraseTrip · derecho al olvido del video (BR-S06, Ley 29733)', () => {
  it('purga objetos S3 + filas de los segmentos del viaje', async () => {
    const { prisma, segments } = makePrisma();
    const { storage, deletes } = makeSpyStorage();
    const svc = new RecordingService(prisma as never, new LiveKitSandboxAdapter(), storage, config);
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));
    expect(segments).toHaveLength(1);
    const s3Key = segments[0]!.s3Key;

    const res = await svc.eraseTrip('trip-1');

    expect(res.purgedSegments).toBe(1);
    expect(deletes).toEqual([s3Key]); // se borró el objeto del segmento
    expect(segments).toHaveLength(0); // fila eliminada
  });

  it('purga todos los segmentos del viaje, sin tocar los de otros viajes', async () => {
    const { prisma, segments } = makePrisma();
    const { storage } = makeSpyStorage();
    const svc = new RecordingService(prisma as never, new LiveKitSandboxAdapter(), storage, config);
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));
    await svc.finishForTrip('trip-1', new Date('2026-05-28T20:30:00.000Z'));
    await svc.startForTrip('trip-1', new Date('2026-05-28T21:00:00.000Z')); // 2º segmento del mismo viaje
    await svc.startForTrip('trip-2', new Date('2026-05-28T20:00:00.000Z'));

    const res = await svc.eraseTrip('trip-1');

    expect(res.purgedSegments).toBe(2);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.tripId).toBe('trip-2');
  });

  it('es idempotente: reprocesar un viaje ya purgado es un no-op (0 segmentos)', async () => {
    const { prisma } = makePrisma();
    const { storage, deletes } = makeSpyStorage();
    const svc = new RecordingService(prisma as never, new LiveKitSandboxAdapter(), storage, config);
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));

    const first = await svc.eraseTrip('trip-1');
    const second = await svc.eraseTrip('trip-1');

    expect(first.purgedSegments).toBe(1);
    expect(second.purgedSegments).toBe(0);
    expect(deletes).toHaveLength(1); // el 2º pase no intenta borrar nada
  });

  it('no-op si el viaje nunca tuvo grabación', async () => {
    const { prisma } = makePrisma();
    const { storage, deletes } = makeSpyStorage();
    const svc = new RecordingService(prisma as never, new LiveKitSandboxAdapter(), storage, config);

    const res = await svc.eraseTrip('trip-sin-video');

    expect(res.purgedSegments).toBe(0);
    expect(deletes).toHaveLength(0);
  });
});
