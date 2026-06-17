import * as Keychain from 'react-native-keychain';
import type { LocalAuthService } from '../../domain/ports/local-auth-service';

/** Servicio (namespace) del refresh token en el almacén seguro del SO. */
const REFRESH_SERVICE = 'veo.driver.refresh';
/** Usuario fijo asociado al token (Keychain requiere un par usuario/clave). */
const REFRESH_USERNAME = 'veo-driver';

/**
 * Implementación del re-login biométrico sobre `react-native-keychain`.
 *
 * - iOS: Keychain con `accessControl: BIOMETRY_CURRENT_SET` → exige Face ID/Touch ID, y se invalida si
 *   cambia el set biométrico (protección anti-suplantación).
 * - Android: Keystore con clave respaldada por hardware y autenticación biométrica.
 * El token solo es accesible en este dispositivo (`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`).
 */
export class KeychainLocalAuthService implements LocalAuthService {
  async isAvailable(): Promise<boolean> {
    try {
      const biometry = await Keychain.getSupportedBiometryType();
      return biometry !== null;
    } catch {
      return false;
    }
  }

  async saveRefreshToken(token: string): Promise<void> {
    await Keychain.setGenericPassword(REFRESH_USERNAME, token, {
      service: REFRESH_SERVICE,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
      accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
  }

  async hasStoredToken(): Promise<boolean> {
    try {
      return await Keychain.hasGenericPassword({ service: REFRESH_SERVICE });
    } catch {
      return false;
    }
  }

  async unlockRefreshToken(promptTitle?: string): Promise<string | null> {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: REFRESH_SERVICE,
        authenticationPrompt: {
          title: promptTitle ?? 'Verifica tu identidad para volver a entrar',
          cancel: 'Cancelar',
        },
      });
      return credentials ? credentials.password : null;
    } catch {
      // Biometría cancelada/fallida: no es un error de la app, devolvemos null.
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await Keychain.resetGenericPassword({ service: REFRESH_SERVICE });
    } catch {
      // Idempotente: si no había token, no hay nada que limpiar.
    }
  }
}

/** Singleton del re-login biométrico. */
export const keychainLocalAuthService: LocalAuthService = new KeychainLocalAuthService();
