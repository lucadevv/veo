import type { HttpClient } from '@veo/api-client';
import {
  deletionRequestResult,
  driverOnboardResult,
  driverPersonalData,
  driverPersonalDataRequest,
  driverProfileView,
  requestPhoneLinkResult,
} from '@veo/api-client';
import { z } from 'zod';
import type {
  DeletionRequested,
  DriverProfile,
  OnboardInput,
  OnboardResult,
  PersonalData,
  PhoneChanged,
  ProfileRepository,
  UpdatePersonalInput,
} from '../../domain';

/**
 * Respuesta de `POST /drivers/me/phone/verify`: el BFF proyecta el perfil de identity al teléfono
 * ya vinculado (que desde ahora es el número de LOGIN del conductor).
 */
const phoneChanged = z.object({ phone: z.string().nullable() });

/** Implementación HTTP del `ProfileRepository` contra el driver-bff. */
export class HttpProfileRepository implements ProfileRepository {
  constructor(private readonly http: HttpClient) {}

  getMe(): Promise<DriverProfile> {
    return this.http.get('/drivers/me', { schema: driverProfileView });
  }

  onboard(input: OnboardInput): Promise<OnboardResult> {
    // `POST /drivers/onboard` devuelve el perfil FINO (`{ driverId, backgroundCheckStatus }`), NO el
    // perfil agregado de `GET /drivers/me`. Se valida con el schema que matchea esa forma real.
    return this.http.post('/drivers/onboard', { body: input, schema: driverOnboardResult });
  }

  updatePersonal(input: UpdatePersonalInput): Promise<PersonalData> {
    // El body se valida con el contrato Zod (`driverPersonalDataRequest`) ANTES de salir a red y la
    // respuesta se parsea con `driverPersonalData` (mismo patrón que `HttpRegistrationRepository`).
    const body = driverPersonalDataRequest.parse(input);
    return this.http.patch('/drivers/me/personal', { body, schema: driverPersonalData });
  }

  async requestPhoneChange(phone: string): Promise<void> {
    // El OTP sale por SMS al número NUEVO (semántica del dueño). identity aplica cooldown/lockout.
    await this.http.post('/drivers/me/phone/request', {
      body: { phone },
      schema: requestPhoneLinkResult,
    });
  }

  verifyPhoneChange(phone: string, code: string): Promise<PhoneChanged> {
    return this.http.post('/drivers/me/phone/verify', {
      body: { phone, code },
      schema: phoneChanged,
    });
  }

  requestDeletion(): Promise<DeletionRequested> {
    // 202: identity registró la solicitud y devuelve el fin de la gracia (política privacy.erasure).
    return this.http.post('/drivers/me/deletion', { schema: deletionRequestResult });
  }
}
