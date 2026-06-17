/**
 * Test de inmutabilidad REAL contra MinIO (self-hosted, S3 Object Lock). Sin mocks.
 * Requiere el dev-stack levantado (MinIO en http://localhost:9002). Si no está disponible,
 * el test se omite con un aviso (no falla el suite en entornos sin infra).
 *
 * Verifica que un objeto escrito con retención COMPLIANCE NO puede borrarse antes de vencer
 * → garantía WORM real a nivel de storage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  S3Client,
  DeleteObjectCommand,
  PutObjectCommand,
  ObjectLockRetentionMode,
} from '@aws-sdk/client-s3';
import { S3ObjectLockStore, auditObjectKey } from './object-lock.store';

const ENDPOINT = process.env.AUDIT_S3_ENDPOINT ?? 'http://localhost:9002';
const ACCESS = process.env.AUDIT_S3_ACCESS_KEY ?? 'veo_dev';
const SECRET = process.env.AUDIT_S3_SECRET_KEY ?? 'veo_dev_secret';
const BUCKET = `veo-audit-test-${Date.now()}`;

let available = false;
let store: S3ObjectLockStore;
let rawClient: S3Client;

beforeAll(async () => {
  store = new S3ObjectLockStore({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKey: ACCESS,
    secretKey: SECRET,
    forcePathStyle: true,
    retentionDays: 1, // retención corta para el test (el objeto queda bloqueado 1 día).
  });
  rawClient = new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
  try {
    await store.ensureBucket();
    available = true;
  } catch (err) {
    console.warn(
      `[object-lock.store.spec] MinIO no disponible en ${ENDPOINT}; test omitido. ${String(err)}`,
    );
  }
});

afterAll(() => {
  rawClient?.destroy();
});

describe('S3 Object Lock (MinIO real)', () => {
  it('crea el bucket con Object Lock y reporta healthy', async () => {
    if (!available) return;
    expect(await store.healthy()).toBe(true);
  });

  it('escribe un objeto WORM y lo lee de vuelta', async () => {
    if (!available) return;
    const key = auditObjectKey(1, 'abc123');
    const body = JSON.stringify({ seq: '1', hash: 'abc123', payload: { ok: true } });
    await store.putImmutable(key, body);
    const read = await store.getObject(key);
    expect(read).toBe(body);
  });

  it('NO permite borrar la versión bloqueada antes de vencer la retención (inmutabilidad real)', async () => {
    if (!available) return;
    const key = auditObjectKey(2, 'lockme');
    const put = await rawClient.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: 'evidencia inmutable',
        ObjectLockMode: ObjectLockRetentionMode.COMPLIANCE,
        ObjectLockRetainUntilDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    );
    expect(put.VersionId).toBeTruthy();
    // Intentar borrar la versión concreta debe ser rechazado por Object Lock (COMPLIANCE).
    await expect(
      rawClient.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: key, VersionId: put.VersionId }),
      ),
    ).rejects.toThrow();
  });
});
