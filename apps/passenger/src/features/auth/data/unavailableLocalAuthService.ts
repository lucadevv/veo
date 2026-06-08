import type { LocalAuthService } from '../domain/localAuthService';

/**
 * Implementación por defecto del puerto biométrico mientras no exista el módulo nativo.
 * `isAvailable` devuelve false (no hay biometría disponible), de modo que el arranque NO bloquea
 * la rehidratación de sesión. La OLEADA NATIVA reemplaza este binding.
 */
export class UnavailableLocalAuthService implements LocalAuthService {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  authenticate(_reason: string): Promise<boolean> {
    // Sin capa nativa no hay prompt; se considera no superado.
    return Promise.resolve(false);
  }
}
