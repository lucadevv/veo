/** Test de los proxies de phone-link (UsersService.{requestPhoneLink,verifyPhoneLink} → identity). */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { InternalRestClient } from '@veo/rpc';
import { UsersService } from './users.service';
import type { UserProfile } from './dto/update-profile.dto';

const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

describe('UsersService.requestPhoneLink', () => {
  it('proxya el request a identity-service propagando la identidad y devuelve {sent:true}', async () => {
    const identity = { post: vi.fn().mockResolvedValue({ sent: true }) } as unknown as InternalRestClient;
    const media = {} as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    const res = await svc.requestPhoneLink(user, { phone: '987654321' });

    expect(res).toEqual({ sent: true });
    expect(identity.post).toHaveBeenCalledWith('/users/me/phone/request', {
      identity: user,
      body: { phone: '987654321' },
    });
  });
});

describe('UsersService.verifyPhoneLink', () => {
  it('proxya el verify a identity-service y devuelve el perfil actualizado con el phone', async () => {
    const profile: UserProfile = {
      id: 'usr-1',
      phone: '+51987654321',
      type: 'PASSENGER',
      kycStatus: 'PENDING',
      name: null,
      email: 'me@veo.pe',
      photoUrl: null,
      documentType: null,
      document: null,
      defaultPaymentMethod: null,
    };
    const identity = { post: vi.fn().mockResolvedValue(profile) } as unknown as InternalRestClient;
    const media = {} as unknown as InternalRestClient;
    const svc = new UsersService(identity, media);

    const res = await svc.verifyPhoneLink(user, { phone: '987654321', code: '123456' });

    expect(res).toEqual(profile);
    expect(identity.post).toHaveBeenCalledWith('/users/me/phone/verify', {
      identity: user,
      body: { phone: '987654321', code: '123456' },
    });
  });
});
