import type { HttpClient } from '@veo/api-client';
import { driverOnboardResult, driverProfileView } from '@veo/api-client';
import type { DriverProfile, OnboardInput, OnboardResult, ProfileRepository } from '../../domain';

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
}
