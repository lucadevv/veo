import {
  deletionRequestResult,
  type HttpClient,
  type PassengerProfile,
  passengerProfile,
  type RequestPhoneLinkResult,
  requestPhoneLinkResult,
  type UpdatePassengerProfile,
} from '@veo/api-client';
import type {AccountDeletionRequest} from '../domain/entities';
import type {ProfileRepository} from '../domain/profileRepository';

/** Implementación de `ProfileRepository` contra el public-bff. */
export class HttpProfileRepository implements ProfileRepository {
  constructor(private readonly http: HttpClient) {}

  getMe(): Promise<PassengerProfile> {
    return this.http.get('/users/me', {schema: passengerProfile});
  }

  updateMe(input: UpdatePassengerProfile): Promise<PassengerProfile> {
    return this.http.patch('/users/me', {
      body: input,
      schema: passengerProfile,
    });
  }

  clearAvatar(): Promise<PassengerProfile> {
    // El backend acepta `photoUrl: null` (columna anulable) para quitar la foto; el cuerpo del
    // PATCH no se valida contra el esquema de request en cliente, así que el `null` viaja tal cual.
    return this.http.patch('/users/me', {
      body: {photoUrl: null},
      schema: passengerProfile,
    });
  }

  requestDeletion(): Promise<AccountDeletionRequest> {
    return this.http.post('/users/me/deletion', {
      schema: deletionRequestResult,
    });
  }

  async cancelDeletion(): Promise<void> {
    // DELETE 204: sin cuerpo.
    await this.http.delete('/users/me/deletion');
  }

  requestPhoneCode(phone: string): Promise<RequestPhoneLinkResult> {
    return this.http.post('/users/me/phone/request', {
      body: {phone},
      schema: requestPhoneLinkResult,
    });
  }

  verifyPhone(phone: string, code: string): Promise<PassengerProfile> {
    // El verify devuelve el perfil actualizado (ya con `phone`): se valida contra `passengerProfile`,
    // la respuesta soberana del contrato (`verifyPhoneLink` describe el body del request).
    return this.http.post('/users/me/phone/verify', {
      body: {phone, code},
      schema: passengerProfile,
    });
  }
}
