import type {HttpClient} from '@veo/api-client';
import { driverProfileView} from '@veo/api-client';
import type {DriverProfile, OnboardInput, ProfileRepository} from '../../domain';

/** Implementación HTTP del `ProfileRepository` contra el driver-bff. */
export class HttpProfileRepository implements ProfileRepository {
  constructor(private readonly http: HttpClient) {}

  getMe(): Promise<DriverProfile> {
    return this.http.get('/drivers/me', {schema: driverProfileView});
  }

  onboard(input: OnboardInput): Promise<DriverProfile> {
    return this.http.post('/drivers/onboard', {body: input, schema: driverProfileView});
  }
}
