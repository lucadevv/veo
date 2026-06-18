import { describe, it, expect, vi } from 'vitest';
import { ValidationError } from '@veo/utils';
import { InternalStorageService } from './internal-storage.service';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import type { StoragePort } from '../ports/storage/storage.port';
import {
  DEFAULT_PRESIGN_GET_TTL_SECONDS,
  DEFAULT_PRESIGN_PUT_TTL_SECONDS,
} from './dto/internal-storage.dto';

describe('InternalStorageService.presignGet · presigned GET interno de una key arbitraria', () => {
  it('llama a presignDownloadUrl con bucket, key y ttl explícito y devuelve { url }', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn().mockResolvedValue('https://signed.example/doc'),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn(),
    };
    const svc = new InternalStorageService(storage);

    const res = await svc.presignGet({
      bucket: 'veo-documents-dev',
      key: 'fleet/driver-1/license.pdf',
      ttlSeconds: 300,
    });

    expect(res).toEqual({ url: 'https://signed.example/doc' });
    expect(storage.presignDownloadUrl).toHaveBeenCalledWith({
      bucket: 'veo-documents-dev',
      key: 'fleet/driver-1/license.pdf',
      expiresSeconds: 300,
    });
  });

  it('aplica el TTL por defecto cuando no se pasa ttlSeconds', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn().mockResolvedValue('https://signed.example/doc'),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn(),
    };
    const svc = new InternalStorageService(storage);

    await svc.presignGet({ bucket: 'veo-documents-dev', key: 'fleet/driver-1/license.pdf' });

    expect(storage.presignDownloadUrl).toHaveBeenCalledWith({
      bucket: 'veo-documents-dev',
      key: 'fleet/driver-1/license.pdf',
      expiresSeconds: DEFAULT_PRESIGN_GET_TTL_SECONDS,
    });
  });

  it('contra el sandbox adapter compone una URL determinista con el bucket pedido', async () => {
    const svc = new InternalStorageService(new StorageSandboxAdapter());

    const { url } = await svc.presignGet({
      bucket: 'veo-documents-dev',
      key: 'fleet/driver-1/license.pdf',
      ttlSeconds: 120,
    });

    expect(url).toBe(
      'https://sandbox.s3.local/download/veo-documents-dev/fleet/driver-1/license.pdf?expires=120',
    );
  });
});

describe('InternalStorageService.presignPut · presigned PUT interno de un documento de flota', () => {
  function buildStorage(): StoragePort {
    return {
      presignDownloadUrl: vi.fn(),
      presignUploadUrl: vi.fn().mockResolvedValue('https://signed.example/upload'),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn(),
    };
  }

  it('firma con bucket, key, contentType y ttl explícito y devuelve url + requiredHeaders', async () => {
    const storage = buildStorage();
    const svc = new InternalStorageService(storage);

    const res = await svc.presignPut({
      bucket: 'veo-documents-dev',
      key: 'drivers/driver-1/documents/LICENSE_A1/abc.jpg',
      contentType: 'image/jpeg',
      ttlSeconds: 300,
    });

    expect(res).toEqual({
      url: 'https://signed.example/upload',
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
    });
    expect(storage.presignUploadUrl).toHaveBeenCalledWith({
      bucket: 'veo-documents-dev',
      key: 'drivers/driver-1/documents/LICENSE_A1/abc.jpg',
      contentType: 'image/jpeg',
      expiresSeconds: 300,
    });
  });

  it('aplica el TTL de subida por defecto cuando no se pasa ttlSeconds', async () => {
    const storage = buildStorage();
    const svc = new InternalStorageService(storage);

    await svc.presignPut({
      bucket: 'veo-documents-dev',
      key: 'drivers/driver-1/documents/SOAT/x.pdf',
      contentType: 'application/pdf',
    });

    expect(storage.presignUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ expiresSeconds: DEFAULT_PRESIGN_PUT_TTL_SECONDS }),
    );
  });

  it('RECHAZA un contentType fuera de la allowlist (ValidationError) sin tocar el storage', async () => {
    const storage = buildStorage();
    const svc = new InternalStorageService(storage);

    await expect(
      svc.presignPut({
        bucket: 'veo-documents-dev',
        key: 'drivers/driver-1/documents/LICENSE_A1/x.svg',
        contentType: 'image/svg+xml',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(storage.presignUploadUrl).not.toHaveBeenCalled();
  });

  it('contra el sandbox adapter compone una URL de subida determinista con el bucket pedido', async () => {
    const svc = new InternalStorageService(new StorageSandboxAdapter());

    const { url, requiredHeaders } = await svc.presignPut({
      bucket: 'veo-documents-dev',
      key: 'drivers/driver-1/documents/PROPERTY_CARD/y.png',
      contentType: 'image/png',
      ttlSeconds: 120,
    });

    expect(url).toBe(
      'https://sandbox.s3.local/upload/veo-documents-dev/drivers/driver-1/documents/PROPERTY_CARD/y.png?expires=120',
    );
    expect(requiredHeaders).toEqual({ 'Content-Type': 'image/png' });
  });
});
