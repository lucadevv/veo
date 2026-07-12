import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RecordingService, roomNameForTrip } from './recording.service';
import { PrismaMediaRepository } from './media.repository';
import { LiveKitSandboxAdapter } from '../ports/livekit/livekit.module';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import type { IssueTokenInput, LiveKitPort } from '../ports/livekit/livekit.port';
import type { StoragePort } from '../ports/storage/storage.port';
import type { Env } from '../config/env.schema';
import type { PolicyReader } from '@veo/policy';

/**
 * PolicyReader falso (registro PBAC) para aseverar que la retención por defecto sale de `media.retention.days`
 * y NO del ENV. `getEnabled` decide si la política gobierna; `number` devuelve el valor configurado. El resto
 * de métodos son no-ops (este servicio solo lee `media.retention`).
 */
function makePolicyReader(days: number, enabled = true): PolicyReader {
  return {
    getEnabled: async () => enabled,
    number: async () => days,
    bool: async (_k, _p, fallback) => fallback,
    list: async (_k, _p, fallback) => fallback,
    params: async () => ({}),
    // Overlay de visibilidad (ADR-025 §3): este servicio no consulta permisos hidden → fail-safe default false (nada restado).
    isPermissionHidden: async (_role, _permission) => false,
  };
}

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
  VIDEO_SSE_KEY_NAME: 'veo-media-key',
  RETENTION_DEFAULT_DAYS: 30,
  RETENTION_INCIDENT_DAYS: 180,
  LIVEKIT_URL: 'ws://localhost:7880',
  WATERMARK_RENDERED_PREFIX: 'watermarked/',
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
  const accessRequests: { id: string; tripId: string; renderedS3Key?: string | null }[] = [];
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
      videoAccessRequest: {
        // Derecho al olvido trip-scoped: TODAS las solicitudes del viaje (sin filtrar por renderedS3Key).
        // La clave de la copia derivada se COMPUTA del id → cae también la copia huérfana (renderedS3Key null).
        findMany: async ({ where }: { where: { tripId: string } }) =>
          accessRequests.filter((r) => r.tripId === where.tripId).map((r) => ({ id: r.id })),
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
      new PrismaMediaRepository(prisma as never),
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
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), livekit, makeSpyStorage().storage, config);

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
      new PrismaMediaRepository(prisma as never),
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

  it('lee la ventana de retención del registro PBAC (media.retention.days), no del ENV', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      new PrismaMediaRepository(prisma as never),
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
      makePolicyReader(7), // política ENCENDIDA con days=7 (≠ 30 del ENV)
    );
    const startedAt = new Date('2026-05-28T20:00:00.000Z');

    await svc.startForTrip('trip-1', startedAt);

    // +7d (del registro), no +30d (del ENV): prueba que la política gobierna la ventana.
    expect(segments[0]?.retentionUntil).toEqual(new Date('2026-06-04T20:00:00.000Z'));
  });

  it('política media.retention enabled:false → cae al default de ENV (nunca acorta la ventana)', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      new PrismaMediaRepository(prisma as never),
      new LiveKitSandboxAdapter(),
      makeSpyStorage().storage,
      config,
      makePolicyReader(3, false), // APAGADA con days=3: se IGNORA el 3, retención sigue con el default de ENV
    );
    const startedAt = new Date('2026-05-28T20:00:00.000Z');

    await svc.startForTrip('trip-1', startedAt);

    // +30d (ENV), NO +3d: apagar la política no borra video antes de tiempo (fail-safe, Ley 29733).
    expect(segments[0]?.retentionUntil).toEqual(new Date('2026-06-27T20:00:00.000Z'));
  });

  it('es idempotente: no duplica la grabación si ya hay una en curso', async () => {
    const { prisma, segments } = makePrisma();
    const svc = new RecordingService(
      new PrismaMediaRepository(prisma as never),
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
      new PrismaMediaRepository(prisma as never),
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
      new PrismaMediaRepository(prisma as never),
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
      new PrismaMediaRepository(prisma as never),
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
      new PrismaMediaRepository(prisma as never),
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
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);
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
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);
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
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);
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
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);

    const res = await svc.eraseTrip('trip-sin-video');

    expect(res.purgedSegments).toBe(0);
    expect(deletes).toHaveLength(0);
  });

  it('purga también las COPIAS con watermark quemado del viaje (PII, Lote 3)', async () => {
    const { prisma, accessRequests } = makePrisma();
    const { storage, deletes } = makeSpyStorage();
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));
    // Una solicitud del viaje con copia derivada READY (video de cabina con PII).
    accessRequests.push({ id: 'req-1', tripId: 'trip-1', renderedS3Key: 'watermarked/req-1.mp4' });
    // Otra de OTRO viaje: no debe tocarse.
    accessRequests.push({ id: 'req-9', tripId: 'trip-9', renderedS3Key: 'watermarked/req-9.mp4' });

    await svc.eraseTrip('trip-1');

    // La clave se COMPUTA del id (renderedKeyFor) — no se lee renderedS3Key.
    expect(deletes).toContain('watermarked/req-1.mp4'); // copia derivada del viaje purgada
    expect(deletes).not.toContain('watermarked/req-9.mp4'); // la de otro viaje, intacta
  });

  it('borra la copia HUÉRFANA (renderedS3Key=null por render fallido tras subir bytes) por clave COMPUTADA', async () => {
    const { prisma, accessRequests } = makePrisma();
    // Storage REAL (sandbox con store en memoria): el round-trip de borrado es honesto.
    const storage = new StorageSandboxAdapter();
    const svc = new RecordingService(new PrismaMediaRepository(prisma as never), new LiveKitSandboxAdapter(), storage, config);
    await svc.startForTrip('trip-1', new Date('2026-05-28T20:00:00.000Z'));

    // Render que SUBIÓ los bytes de la copia con PII pero cuya tx de READY falló → renderedS3Key quedó null.
    // La fila NO referencia la copia, pero el objeto EXISTE en el storage bajo la clave determinista.
    accessRequests.push({ id: 'req-orphan', tripId: 'trip-1', renderedS3Key: null });
    const orphanKey = 'watermarked/req-orphan.mp4';
    await storage.uploadObject({
      key: orphanKey,
      body: Buffer.from('copia-derivada-con-PII-huerfana'),
      contentType: 'video/mp4',
    });
    // Pre-condición: la copia huérfana EXISTE en el storage.
    await expect(storage.getObjectStream(orphanKey)).resolves.toBeDefined();

    await svc.eraseTrip('trip-1');

    // La copia huérfana YA NO está: se borró por clave COMPUTADA, NO por el campo DB (que era null).
    await expect(storage.getObjectStream(orphanKey)).rejects.toThrow();
  });
});
