import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '@veo/utils';
import { AvatarService } from './avatar.service';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import type { StoragePort } from '../ports/storage/storage.port';
import type { Env } from '../config/env.schema';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const config = new ConfigService<Env, true>({
  S3_BUCKET_AVATAR: 'veo-avatars-dev',
  S3_PUBLIC_BASE_URL: 'http://localhost:9002',
  SIGNED_URL_TTL_SECONDS: 300,
  AVATAR_MAX_BYTES,
});

function makeService(storage: StoragePort = new StorageSandboxAdapter()): AvatarService {
  return new AvatarService(storage, config);
}

describe('StorageSandboxAdapter.presignUploadUrl · URL determinista de subida', () => {
  it('compone una URL estable con bucket, key y expiración', async () => {
    const adapter = new StorageSandboxAdapter();
    const url = await adapter.presignUploadUrl({
      key: 'avatars/usr-1/avatar.png',
      contentType: 'image/png',
      expiresSeconds: 300,
      bucket: 'veo-avatars-dev',
    });
    expect(url).toBe(
      'https://sandbox.s3.local/upload/veo-avatars-dev/avatars/usr-1/avatar.png?expires=300',
    );
  });
});

describe('AvatarService.createUploadTicket · presign del avatar', () => {
  it('devuelve un ticket PUT con key determinista por usuario y publicUrl path-style', async () => {
    const svc = makeService();
    const ticket = await svc.createUploadTicket({
      userId: 'usr-1',
      contentType: 'image/jpeg',
      ext: 'jpg',
    });

    expect(ticket.method).toBe('PUT');
    expect(ticket.headers['Content-Type']).toBe('image/jpeg');
    expect(ticket.expiresInSeconds).toBe(300);
    expect(ticket.maxBytes).toBe(AVATAR_MAX_BYTES);
    expect(ticket.key).toBe('avatars/usr-1/avatar.jpg');
    expect(ticket.publicUrl).toBe(`http://localhost:9002/veo-avatars-dev/${ticket.key}`);
    expect(ticket.uploadUrl).toContain('https://sandbox.s3.local/upload/veo-avatars-dev/');
  });

  it('acepta image/png con ext png y image/webp con ext webp', async () => {
    const svc = makeService();
    const png = await svc.createUploadTicket({ userId: 'u', contentType: 'image/png', ext: 'png' });
    const webp = await svc.createUploadTicket({
      userId: 'u',
      contentType: 'image/webp',
      ext: 'webp',
    });
    expect(png.key.endsWith('.png')).toBe(true);
    expect(webp.key.endsWith('.webp')).toBe(true);
  });

  it('rechaza una extensión incoherente con el contentType', async () => {
    const svc = makeService();
    await expect(
      svc.createUploadTicket({ userId: 'usr-1', contentType: 'image/png', ext: 'jpg' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('usa una key DETERMINISTA: la misma combinación userId+ext sobrescribe (sin huérfanos)', async () => {
    const svc = makeService();
    const a = await svc.createUploadTicket({ userId: 'u', contentType: 'image/png', ext: 'png' });
    const b = await svc.createUploadTicket({ userId: 'u', contentType: 'image/png', ext: 'png' });
    expect(a.key).toBe(b.key);
  });
});

describe('AvatarService.confirmUpload · validación de cuota tras la subida', () => {
  const okKey = 'avatars/usr-1/avatar.jpg';

  it('confirma y devuelve la publicUrl cuando el tamaño está dentro de la cuota', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn(),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn().mockResolvedValue(1_000_000),
      deletePrefix: vi.fn(),
      getObjectStream: vi.fn(),
      uploadObject: vi.fn(),
    };
    const svc = makeService(storage);

    const res = await svc.confirmUpload({ userId: 'usr-1', key: okKey });

    expect(res.key).toBe(okKey);
    expect(res.sizeBytes).toBe(1_000_000);
    expect(res.publicUrl).toBe(`http://localhost:9002/veo-avatars-dev/${okKey}`);
    expect(storage.getObjectSize).toHaveBeenCalledWith(okKey, 'veo-avatars-dev');
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('borra el objeto y rechaza cuando excede AVATAR_MAX_BYTES', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn(),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      getObjectSize: vi.fn().mockResolvedValue(AVATAR_MAX_BYTES + 1),
      deletePrefix: vi.fn(),
      getObjectStream: vi.fn(),
      uploadObject: vi.fn(),
    };
    const svc = makeService(storage);

    await expect(svc.confirmUpload({ userId: 'usr-1', key: okKey })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(okKey, 'veo-avatars-dev');
  });

  it('rechaza si el objeto no existe (0 bytes) sin borrar', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn(),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn().mockResolvedValue(0),
      deletePrefix: vi.fn(),
      getObjectStream: vi.fn(),
      uploadObject: vi.fn(),
    };
    const svc = makeService(storage);

    await expect(svc.confirmUpload({ userId: 'usr-1', key: okKey })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('rechaza una key que no pertenece al usuario autenticado (no toca el storage)', async () => {
    const storage: StoragePort = {
      presignDownloadUrl: vi.fn(),
      presignUploadUrl: vi.fn(),
      deleteObject: vi.fn(),
      getObjectSize: vi.fn(),
      deletePrefix: vi.fn(),
      getObjectStream: vi.fn(),
      uploadObject: vi.fn(),
    };
    const svc = makeService(storage);

    await expect(
      svc.confirmUpload({ userId: 'usr-1', key: 'avatars/otro/avatar.jpg' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(storage.getObjectSize).not.toHaveBeenCalled();
  });
});
