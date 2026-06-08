import type {ProfileRepository} from '../repositories/profile-repository';
import type {DriverProfile} from '../entities';

/** Caso de uso: obtener el perfil agregado del conductor autenticado. */
export class GetProfileUseCase {
  constructor(private readonly profile: ProfileRepository) {}

  execute(): Promise<DriverProfile> {
    return this.profile.getMe();
  }
}
