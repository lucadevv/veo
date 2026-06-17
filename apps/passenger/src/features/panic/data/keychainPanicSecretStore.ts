import * as Keychain from 'react-native-keychain';
import type {PanicSecretStore} from '../domain/panicSecretStore';

/** Servicio (namespace) del secreto de pánico en el Keychain/Keystore. */
const PANIC_SECRET_SERVICE = 'pe.veo.passenger.panic.hmac';
/** Usuario fijo: solo guardamos un secreto por device. */
const PANIC_SECRET_ACCOUNT = 'panic-hmac-secret';

/**
 * Implementación REAL del almacén del secreto HMAC del pánico sobre el Keychain (iOS) / Keystore
 * (Android) vía `react-native-keychain`.
 *
 * Accesibilidad `AFTER_FIRST_UNLOCK`: el secreto debe poder leerse en segundo plano / pantalla
 * bloqueada (el pánico no puede pedir biometría). Por eso NO se aplica control de acceso biométrico.
 */
export class KeychainPanicSecretStore implements PanicSecretStore {
  async getSecret(): Promise<string | null> {
    const credentials = await Keychain.getGenericPassword({
      service: PANIC_SECRET_SERVICE,
    });
    return credentials ? credentials.password : null;
  }

  async setSecret(secret: string): Promise<void> {
    await Keychain.setGenericPassword(PANIC_SECRET_ACCOUNT, secret, {
      service: PANIC_SECRET_SERVICE,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
      // Android: clave en Keystore, sin biometría (debe firmarse sin interacción).
      storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    });
  }

  async clearSecret(): Promise<void> {
    await Keychain.resetGenericPassword({service: PANIC_SECRET_SERVICE});
  }
}
