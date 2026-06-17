/**
 * Perfil del pasajero. La lectura de /users/me está delimitada por la identidad propagada
 * (el downstream resuelve el usuario desde el header firmado), por eso usa REST interno y no
 * un Get por id. PATCH/deletion son comandos.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_IDENTITY, REST_MEDIA } from '../infra/downstream.tokens';
import { type UpdateProfileDto, type UserProfile } from './dto/update-profile.dto';
import {
  type PresignAvatarUploadDto,
  type AvatarUploadTicket,
  type ConfirmAvatarUploadDto,
  type AvatarUploadConfirmed,
} from './dto/presign-avatar.dto';
import { type RecordConsentInput, type ConsentRecorded } from './dto/record-consent.dto';
import { type RequestPhoneLinkDto, type VerifyPhoneLinkDto } from './dto/phone-link.dto';

@Injectable()
export class UsersService {
  constructor(
    @Inject(REST_IDENTITY) private readonly identity: InternalRestClient,
    @Inject(REST_MEDIA) private readonly media: InternalRestClient,
  ) {}

  getProfile(user: AuthenticatedUser): Promise<UserProfile> {
    return this.identity.get<UserProfile>('/users/me', { identity: user });
  }

  updateProfile(user: AuthenticatedUser, dto: UpdateProfileDto): Promise<UserProfile> {
    return this.identity.patch<UserProfile>('/users/me', { identity: user, body: dto });
  }

  /**
   * Proxya el presign de subida del avatar a media-service (REST interno firmado). Devuelve el
   * ticket tal cual: la app sube el binario a `uploadUrl` y guarda `publicUrl` con PATCH /users/me.
   */
  presignAvatarUpload(
    user: AuthenticatedUser,
    dto: PresignAvatarUploadDto,
  ): Promise<AvatarUploadTicket> {
    return this.media.post<AvatarUploadTicket>('/media/avatars/presign', {
      identity: user,
      body: dto,
    });
  }

  /**
   * Proxya la confirmación de la subida del avatar a media-service. media-service valida la cuota de
   * tamaño (borra el objeto si excede) y devuelve la `publicUrl` definitiva para guardar en el perfil.
   */
  confirmAvatarUpload(
    user: AuthenticatedUser,
    dto: ConfirmAvatarUploadDto,
  ): Promise<AvatarUploadConfirmed> {
    return this.media.post<AvatarUploadConfirmed>('/media/avatars/confirm', {
      identity: user,
      body: dto,
    });
  }

  /**
   * Registra un consentimiento del pasajero (Ley 29733). Proxya a identity-service (REST interno
   * firmado) propagando la identidad del pasajero; añade la `ip` del request como evidencia.
   * identity-service inserta un row inmutable (append-only).
   */
  recordConsent(
    user: AuthenticatedUser,
    input: RecordConsentInput,
    ip: string | null,
  ): Promise<ConsentRecorded> {
    return this.identity.post<ConsentRecorded>('/users/consents', {
      identity: user,
      // dedupKey → idempotencyKey del REST interno (espeja PanicService.trigger del BFF).
      idempotencyKey: input.dedupKey,
      body: {
        dataProcessing: input.dataProcessing,
        inCabinCamera: input.inCabinCamera,
        location: input.location,
        marketing: input.marketing,
        policyVersion: input.policyVersion,
        ip,
        dedupKey: input.dedupKey,
      },
    });
  }

  /** Consentimiento VIGENTE del pasajero (el más reciente). `null` si nunca registró. */
  getCurrentConsent(user: AuthenticatedUser): Promise<ConsentRecorded | null> {
    return this.identity.get<ConsentRecorded | null>('/users/consents', { identity: user });
  }

  /**
   * Proxya la solicitud de OTP para vincular un teléfono al perfil (phone-link) a identity-service,
   * propagando la identidad firmada del pasajero. identity reusa la infra OTP del login.
   */
  requestPhoneLink(user: AuthenticatedUser, dto: RequestPhoneLinkDto): Promise<{ sent: true }> {
    return this.identity.post<{ sent: true }>('/users/me/phone/request', { identity: user, body: dto });
  }

  /**
   * Proxya la verificación del OTP de phone-link. Devuelve el perfil actualizado (con el phone)
   * tal cual lo emite identity-service.
   */
  verifyPhoneLink(user: AuthenticatedUser, dto: VerifyPhoneLinkDto): Promise<UserProfile> {
    return this.identity.post<UserProfile>('/users/me/phone/verify', { identity: user, body: dto });
  }

  requestDeletion(user: AuthenticatedUser): Promise<{ graceUntil: string }> {
    return this.identity.post<{ graceUntil: string }>('/users/me/deletion', { identity: user });
  }

  cancelDeletion(user: AuthenticatedUser): Promise<void> {
    return this.identity.delete<void>('/users/me/deletion', { identity: user });
  }
}
