/**
 * Contactos de confianza (BR-I06). El listado es lectura (gRPC GetTrustedContacts por userId);
 * altas/bajas/verificación de OTP son comandos (REST interno firmado).
 */
import { Inject, Injectable } from '@nestjs/common';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { GRPC_SHARE, REST_SHARE } from '../infra/downstream.tokens';
import { internalGrpcMetadata } from '../infra/internal-identity';
import type { TrustedContactsReply } from '../infra/grpc-types';
import {
  type AddContactDto,
  type ContactResource,
  type ContactView,
  type VerifyContactOtpDto,
} from './dto/contacts.dto';

@Injectable()
export class ContactsService {
  constructor(
    @Inject(GRPC_SHARE) private readonly shareGrpc: GrpcServiceClient,
    @Inject(REST_SHARE) private readonly shareRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  async list(user: AuthenticatedUser): Promise<ContactView[]> {
    const meta = internalGrpcMetadata(user, this.secret);
    const reply = await this.shareGrpc.call<TrustedContactsReply>(
      'GetTrustedContacts',
      { userId: user.userId },
      meta,
    );
    return reply.contacts.map((c) => ({
      id: c.id,
      phone: c.phone,
      name: c.name,
      relationship: c.relationship,
      verified: c.otpVerified,
    }));
  }

  add(
    user: AuthenticatedUser,
    dto: AddContactDto,
  ): Promise<{ contact: ContactResource; otpSent: true }> {
    return this.shareRest.post<{ contact: ContactResource; otpSent: true }>('/contacts', {
      identity: user,
      body: dto,
    });
  }

  verifyOtp(
    user: AuthenticatedUser,
    id: string,
    dto: VerifyContactOtpDto,
  ): Promise<ContactResource> {
    return this.shareRest.post<ContactResource>(`/contacts/${id}/verify-otp`, {
      identity: user,
      body: { code: dto.code },
    });
  }

  resendOtp(user: AuthenticatedUser, id: string): Promise<{ otpSent: true }> {
    return this.shareRest.post<{ otpSent: true }>(`/contacts/${id}/resend-otp`, {
      identity: user,
    });
  }

  remove(user: AuthenticatedUser, id: string): Promise<void> {
    return this.shareRest.delete<void>(`/contacts/${id}`, { identity: user });
  }
}
