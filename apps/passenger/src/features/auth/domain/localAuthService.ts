/**
 * Puerto de autenticación biométrica local (DIP). El re-login biométrico (Face ID / huella) lo
 * implementa la OLEADA NATIVA (react-native-keychain / biometrics). Aquí solo se define la
 * abstracción para que el arranque pueda exigir biometría antes de rehidratar la sesión.
 *
 * Firma exacta para la oleada nativa:
 *   isAvailable(): Promise<boolean>            // hay hardware + enrolamiento
 *   authenticate(reason: string): Promise<boolean>  // true si el usuario superó el prompt
 */
export interface LocalAuthService {
  /** Indica si el dispositivo soporta y tiene configurada biometría. */
  isAvailable(): Promise<boolean>;
  /** Lanza el prompt biométrico; resuelve true si el usuario se autenticó. */
  authenticate(reason: string): Promise<boolean>;
}
