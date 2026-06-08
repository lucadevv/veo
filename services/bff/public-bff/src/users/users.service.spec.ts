/** Test del proxy de presign del avatar (UsersService.presignAvatarUpload → media-service). */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { InternalRestClient } from '@veo/rpc';
import { UsersService } from './users.service';
import type { AvatarUploadConfirmed, AvatarUploadTicket } from './dto/presign-avatar.dto';
import type { ConsentRecorded } from './dto/record-consent.dto';

const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

const ticket: AvatarUploadTicket = {
  uploadUrl: 'https://sandbox.s3.local/upload/veo-avatars-dev/avatars/usr-1/avatar.jpg?expires=300',
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  key: 'avatars/usr-1/avatar.jpg',
  publicUrl: 'http://localhost:9002/veo-avatars-dev/avatars/usr-1/avatar.jpg',
  expiresInSeconds: 300,
  maxBytes: 5 * 1024 * 1024,
};

describe('UsersService.presignAvatarUpload', () => {
  it('proxya el presign a media-service propagando la identidad y devuelve el ticket', async () => {
    const identity = {} as unknown as InternalRestClient;
    const media = { post: vi.fn().mockResolvedValue(ticket) } as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    const res = await svc.presignAvatarUpload(user, { contentType: 'image/jpeg', ext: 'jpg' });

    expect(res).toEqual(ticket);
    expect(media.post).toHaveBeenCalledWith('/media/avatars/presign', {
      identity: user,
      body: { contentType: 'image/jpeg', ext: 'jpg' },
    });
  });
});

describe('UsersService.recordConsent', () => {
  it('proxya el consentimiento a identity-service propagando la identidad y la IP del request', async () => {
    const recorded: ConsentRecorded = {
      id: 'consent-1',
      userId: 'usr-1',
      dataProcessing: true,
      inCabinCamera: true,
      location: false,
      marketing: false,
      policyVersion: '2026-05-01',
      acceptedAt: '2026-05-31T12:00:00.000Z',
    };
    const identity = { post: vi.fn().mockResolvedValue(recorded) } as unknown as InternalRestClient;
    const media = {} as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    const res = await svc.recordConsent(
      user,
      { dataProcessing: true, inCabinCamera: true, location: false, marketing: false, policyVersion: '2026-05-01' },
      '200.48.225.130',
    );

    expect(res).toEqual(recorded);
    expect(identity.post).toHaveBeenCalledWith('/users/consents', {
      identity: user,
      body: {
        dataProcessing: true,
        inCabinCamera: true,
        location: false,
        marketing: false,
        policyVersion: '2026-05-01',
        ip: '200.48.225.130',
      },
    });
  });

  it('propaga ip null cuando el request no trae IP determinable', async () => {
    const identity = { post: vi.fn().mockResolvedValue({}) } as unknown as InternalRestClient;
    const media = {} as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    await svc.recordConsent(
      user,
      { dataProcessing: true, inCabinCamera: false, location: true, marketing: true, policyVersion: '2026-05-01' },
      null,
    );

    expect(identity.post).toHaveBeenCalledWith('/users/consents', {
      identity: user,
      body: {
        dataProcessing: true,
        inCabinCamera: false,
        location: true,
        marketing: true,
        policyVersion: '2026-05-01',
        ip: null,
      },
    });
  });
});

describe('UsersService.confirmAvatarUpload', () => {
  it('proxya la confirmación a media-service propagando la identidad y devuelve la publicUrl', async () => {
    const confirmed: AvatarUploadConfirmed = {
      key: 'avatars/usr-1/avatar.jpg',
      publicUrl: 'http://localhost:9002/veo-avatars-dev/avatars/usr-1/avatar.jpg',
      sizeBytes: 1_000_000,
    };
    const identity = {} as unknown as InternalRestClient;
    const media = { post: vi.fn().mockResolvedValue(confirmed) } as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    const res = await svc.confirmAvatarUpload(user, { key: 'avatars/usr-1/avatar.jpg' });

    expect(res).toEqual(confirmed);
    expect(media.post).toHaveBeenCalledWith('/media/avatars/confirm', {
      identity: user,
      body: { key: 'avatars/usr-1/avatar.jpg' },
    });
  });
});
