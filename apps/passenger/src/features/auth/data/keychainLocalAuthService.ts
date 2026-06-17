import * as Keychain from 'react-native-keychain';
import type {LocalAuthService} from '../domain/localAuthService';

/** Servicio del "candado biométrico": una entrada protegida por biometría que fuerza el prompt. */
const BIOMETRIC_GATE_SERVICE = 'pe.veo.passenger.biometric.gate';
const BIOMETRIC_GATE_ACCOUNT = 'biometric-gate';
/** Valor opaco; su contenido no importa, solo que su lectura exija biometría. */
const BIOMETRIC_GATE_TOKEN = 'veo-biometric-unlock-v1';

/**
 * Implementación REAL del puerto biométrico sobre `react-native-keychain`.
 *
 * `authenticate` apoya el RE-LOGIN biométrico: guarda (una vez) una entrada en el Keychain/Keystore
 * protegida con `BIOMETRY_ANY` y, para autenticar, intenta LEERLA con un `authenticationPrompt`. La
 * lectura solo tiene éxito tras Face ID / huella; así desbloqueamos el uso del refresh token.
 */
export class KeychainLocalAuthService implements LocalAuthService {
  async isAvailable(): Promise<boolean> {
    try {
      const type = await Keychain.getSupportedBiometryType();
      return type !== null;
    } catch {
      return false;
    }
  }

  /** Garantiza que exista la entrada protegida por biometría (no prompt­ea al escribir). */
  private async ensureGate(): Promise<void> {
    const exists = await Keychain.hasGenericPassword({
      service: BIOMETRIC_GATE_SERVICE,
    });
    if (exists) {
      return;
    }
    await Keychain.setGenericPassword(
      BIOMETRIC_GATE_ACCOUNT,
      BIOMETRIC_GATE_TOKEN,
      {
        service: BIOMETRIC_GATE_SERVICE,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        // Android: clave en Keystore que exige autenticación biométrica para descifrar.
        storage: Keychain.STORAGE_TYPE.AES_GCM,
      },
    );
  }

  async authenticate(reason: string): Promise<boolean> {
    try {
      await this.ensureGate();
      const credentials = await Keychain.getGenericPassword({
        service: BIOMETRIC_GATE_SERVICE,
        authenticationPrompt: {title: reason},
      });
      // Solo se considera superado si la lectura biométrica devolvió la entrada esperada.
      return (
        Boolean(credentials) &&
        credentials !== false &&
        credentials.password === BIOMETRIC_GATE_TOKEN
      );
    } catch {
      // Cancelación del usuario, lockout o fallo del hardware: no superado.
      return false;
    }
  }
}
