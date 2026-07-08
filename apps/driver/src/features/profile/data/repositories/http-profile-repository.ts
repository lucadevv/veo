import type { HttpClient } from '@veo/api-client';
import {
  driverOnboardResult,
  driverPersonalData,
  driverPersonalDataRequest,
  driverProfileView,
} from '@veo/api-client';
import type {
  DriverProfile,
  OnboardInput,
  OnboardResult,
  PersonalData,
  ProfileRepository,
  UpdatePersonalInput,
} from '../../domain';

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
}
