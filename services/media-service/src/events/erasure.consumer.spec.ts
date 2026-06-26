/**
 * Tests del derecho al olvido (BR-S06, Ley 29733) en media-service:
 *  - AvatarService.eraseUser borra el avatar del usuario (todas las extensiones conocidas).
 *  - ErasureConsumer (ÚNICO consumer del group media-service.erasure: user.deleted +
 *    trip.pii_erased) purga avatar y video de cabina, valida el payload y deduplica.
 *
 * Estilo media: clases construidas directamente con dobles, sin Nest DI. RecordingService va detrás
 * de un doble (su lógica de purga se prueba en recording.service.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AvatarService } from '../media/avatar.service';
import { ErasureConsumer } from './erasure.consumer';
import type { RecordingService } from '../media/recording.service';
import type { StoragePort } from '../ports/storage/storage.port';
import type { Env } from '../config/env.schema';
import type { EventEnvelope } from '@veo/events';

const config = new ConfigService<Env, true>({
  S3_BUCKET_AVATAR: 'veo-avatars-dev',
  S3_PUBLIC_BASE_URL: 'http://localhost:9002',
  SIGNED_URL_TTL_SECONDS: 300,
  AVATAR_MAX_BYTES: 5 * 1024 * 1024,
  KAFKA_BROKERS: 'localhost:9094',
} as Partial<Env> as Env);

/** Storage espía que registra cada borrado (key + bucket). */
function makeSpyStorage(): { storage: StoragePort; deletes: { key: string; bucket?: string }[] } {
  const deletes: { key: string; bucket?: string }[] = [];
  const storage: StoragePort = {
    presignDownloadUrl: async () => 'url',
    presignUploadUrl: async () => 'url',
    deleteObject: async (key: string, bucket?: string) => {
      deletes.push({ key, bucket });
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

/** Redis en memoria (solo get/set con NX/EX) para deduplicación. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    },
  };
}

function makeRecording() {
  const erased: string[] = [];
  const recording = {
    eraseTrip: vi.fn(async (tripId: string) => {
      erased.push(tripId);
      return { purgedSegments: 1 };
    }),
  } as unknown as RecordingService;
  return { recording, erased };
}

function userDeletedEnvelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'user.deleted',
    occurredAt: '2026-06-04T00:00:00.000Z',
    producer: 'identity-service',
    schemaVersion: 1,
    payload,
  };
}

function tripErasedEnvelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'trip.pii_erased',
    occurredAt: '2026-06-04T00:00:00.000Z',
    producer: 'trip-service',
    schemaVersion: 1,
    payload,
  };
}

interface ErasureConsumerInternals {
  onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
  onTripErased(e: EventEnvelope<unknown>): Promise<void>;
}

function makeConsumer(avatars: AvatarService, recording: RecordingService) {
  const consumer = new ErasureConsumer(avatars, recording, makeRedis() as never, config);
  const internals = consumer as unknown as ErasureConsumerInternals;
  return {
    consumer,
    invokeUserDeleted: (e: EventEnvelope<unknown>) => internals.onUserDeleted(e),
    invokeTripErased: (e: EventEnvelope<unknown>) => internals.onTripErased(e),
  };
}

describe('AvatarService.eraseUser (derecho al olvido)', () => {
  it('borra el avatar del usuario en todas las extensiones conocidas, en el bucket de avatares', async () => {
    const { storage, deletes } = makeSpyStorage();
    const svc = new AvatarService(storage, config);

    const res = await svc.eraseUser('usr-1');

    expect(res.deletedKeys).toBe(4);
    const keys = deletes.map((d) => d.key).sort();
    expect(keys).toEqual([
      'avatars/usr-1/avatar.jpeg',
      'avatars/usr-1/avatar.jpg',
      'avatars/usr-1/avatar.png',
      'avatars/usr-1/avatar.webp',
    ]);
    // Siempre en el bucket de avatares (no el de video).
    expect(deletes.every((d) => d.bucket === 'veo-avatars-dev')).toBe(true);
  });

  it('es idempotente: reprocesar borra las mismas keys (deleteObject es no-op si no existe)', async () => {
    const { storage, deletes } = makeSpyStorage();
    const svc = new AvatarService(storage, config);

    await svc.eraseUser('usr-1');
    await svc.eraseUser('usr-1');

    expect(deletes).toHaveLength(8);
  });
});

describe('ErasureConsumer · user.deleted', () => {
  function setup() {
    const { storage, deletes } = makeSpyStorage();
    const avatars = new AvatarService(storage, config);
    const eraseSpy = vi.spyOn(avatars, 'eraseUser');
    const { recording } = makeRecording();
    const { invokeUserDeleted: invoke } = makeConsumer(avatars, recording);
    return { deletes, eraseSpy, invoke };
  }

  it('purga el avatar al recibir user.deleted', async () => {
    const { deletes, invoke } = setup();

    await invoke(userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-04T00:00:00.000Z' }));

    expect(deletes.map((d) => d.key)).toContain('avatars/usr-1/avatar.png');
    expect(deletes).toHaveLength(4);
  });

  it('ignora payloads inválidos sin borrar nada (no lanza)', async () => {
    const { deletes, eraseSpy, invoke } = setup();

    await invoke(userDeletedEnvelope({ nope: true }));

    expect(eraseSpy).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(0);
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { eraseSpy, invoke } = setup();
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-04T00:00:00.000Z' });

    await invoke(evt);
    await invoke(evt);

    expect(eraseSpy).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    const { storage } = makeSpyStorage();
    const avatars = new AvatarService(storage, config);
    let calls = 0;
    vi.spyOn(avatars, 'eraseUser').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('S3 caído');
      return { deletedKeys: 4 };
    });
    const { recording } = makeRecording();
    const { invokeUserDeleted: invoke } = makeConsumer(avatars, recording);
    const evt = userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-04T00:00:00.000Z' });

    await expect(invoke(evt)).rejects.toThrow('S3 caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });
});

describe('ErasureConsumer · trip.pii_erased (derecho al olvido del video)', () => {
  function setup(recording: RecordingService) {
    const { storage } = makeSpyStorage();
    const avatars = new AvatarService(storage, config);
    return makeConsumer(avatars, recording);
  }

  it('purga el video del viaje al recibir trip.pii_erased', async () => {
    const { recording, erased } = makeRecording();
    const { invokeTripErased: invoke } = setup(recording);

    await invoke(
      tripErasedEnvelope({
        tripId: 'trip-1',
        passengerId: 'pax-1',
        at: '2026-06-04T00:00:00.000Z',
      }),
    );

    expect(erased).toEqual(['trip-1']);
  });

  it('ignora payloads inválidos sin purgar nada (no lanza)', async () => {
    const { recording } = makeRecording();
    const { invokeTripErased: invoke } = setup(recording);

    await invoke(tripErasedEnvelope({ nope: true }));

    expect(recording.eraseTrip).not.toHaveBeenCalled();
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { recording } = makeRecording();
    const { invokeTripErased: invoke } = setup(recording);
    const evt = tripErasedEnvelope({
      tripId: 'trip-1',
      passengerId: 'pax-1',
      at: '2026-06-04T00:00:00.000Z',
    });

    await invoke(evt);
    await invoke(evt);

    expect(recording.eraseTrip).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    let calls = 0;
    const recording = {
      eraseTrip: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('S3 caído');
        return { purgedSegments: 1 };
      }),
    } as unknown as RecordingService;
    const { invokeTripErased: invoke } = setup(recording);
    const evt = tripErasedEnvelope({
      tripId: 'trip-1',
      passengerId: 'pax-1',
      at: '2026-06-04T00:00:00.000Z',
    });

    await expect(invoke(evt)).rejects.toThrow('S3 caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });

  it('los DOS eventos comparten el dedup del group: eventIds DISTINTOS no se pisan', async () => {
    const { storage } = makeSpyStorage();
    const avatars = new AvatarService(storage, config);
    const avatarSpy = vi.spyOn(avatars, 'eraseUser');
    const { recording } = makeRecording();
    const { invokeUserDeleted, invokeTripErased } = makeConsumer(avatars, recording);

    await invokeUserDeleted(
      userDeletedEnvelope({ userId: 'usr-1', at: '2026-06-04T00:00:00.000Z' }, 'evt-user'),
    );
    await invokeTripErased(
      tripErasedEnvelope(
        { tripId: 'trip-1', passengerId: 'pax-1', at: '2026-06-04T00:00:00.000Z' },
        'evt-trip',
      ),
    );

    expect(avatarSpy).toHaveBeenCalledTimes(1);
    expect(recording.eraseTrip).toHaveBeenCalledTimes(1);
  });
});
