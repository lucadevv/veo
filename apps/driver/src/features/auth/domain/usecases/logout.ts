import type {AuthRepository} from '../repositories/auth-repository';
import type {LogoutResult} from '../entities';

/**
 * Caso de uso: cerrar sesión revocando el refresh token en el servidor.
 * La limpieza del estado local la realiza el llamador (sessionStore) tras esta promesa.
 */
export class LogoutUseCase {
  constructor(private readonly auth: AuthRepository) {}

  execute(refreshToken: string): Promise<LogoutResult> {
    return this.auth.logout({refreshToken});
  }
}
