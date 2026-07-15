import * as Keychain from 'react-native-keychain';
import type {
  LocalAuthService,
  UnlockRefreshTokenOutcome,
} from '../../domain/ports/local-auth-service';

/** Servicio (namespace) del refresh token en el almacén seguro del SO. */
const REFRESH_SERVICE = 'veo.driver.refresh';
/** Usuario fijo asociado al token (Keychain requiere un par usuario/clave). */
const REFRESH_USERNAME = 'veo-driver';

/**
 * Marcadores de CANCELACIÓN por el usuario en el error de `react-native-keychain` (cross-platform). El resto
 * de los errores (fallo de match real, sensor ocupado, ambiguo) NO son cancelación → se tratan como `failed`
 * (banner). Conservador a PROPÓSITO: si un marcador no matchea, cae en `failed` → el usuario ve el banner (el
 * intent del fix: un fallo real SIEMPRE avisa), nunca al revés.
 *  - iOS: `errSecUserCanceled` = -128; el message suele incluir "UserCancel"/"canceled".
 *  - Android: BiometricPrompt ERROR_USER_CANCELED(10) / ERROR_NEGATIVE_BUTTON(13) / ERROR_CANCELED(5),
 *    envueltos por react-native-keychain como `"code: N, msg: ..."` en el message.
 */
const CANCELLATION_MARKERS = [
  '-128',
  'UserCancel',
  'usercancel',
  'canceled',
  'cancelled',
  'code: 10',
  'code: 13',
  'code: 5',
];

function isUserCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string | number } | null)?.code;
  const haystack = `${String(code ?? '')} ${message}`.toLowerCase();
  return CANCELLATION_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

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

  async unlockRefreshToken(promptTitle?: string): Promise<UnlockRefreshTokenOutcome> {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: REFRESH_SERVICE,
        authenticationPrompt: {
          title: promptTitle ?? 'Verifica tu identidad para volver a entrar',
          cancel: 'Cancelar',
        },
      });
      // `false` = no hay token guardado (no lanza) → empty. Con credenciales → ok.
      return credentials ? { status: 'ok', token: credentials.password } : { status: 'empty' };
    } catch (error) {
      // DRIFT-1: distinguimos cancelación (silenciosa) de FALLO biométrico real (banner). Antes se colapsaba
      // todo a null → un fallo genuino de Face ID no avisaba.
      return isUserCancellation(error) ? { status: 'cancelled' } : { status: 'failed', error };
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
