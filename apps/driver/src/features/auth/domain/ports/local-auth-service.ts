/**
 * Puerto de autenticación LOCAL del dispositivo (Face ID / huella).
 *
 * Permite un re-login rápido y seguro: el refresh token se guarda en el almacén seguro del SO
 * (Keychain iOS / Keystore Android) protegido por biometría. Al expirar la sesión, el conductor
 * desbloquea el token con su rostro/huella sin reingresar el OTP.
 */
export interface LocalAuthService {
  /** true si el dispositivo tiene biometría disponible y configurada. */
  isAvailable(): Promise<boolean>;
  /** Persiste el refresh token bajo protección biométrica. */
  saveRefreshToken(token: string): Promise<void>;
  /** true si hay un refresh token guardado para este dispositivo. */
  hasStoredToken(): Promise<boolean>;
  /**
   * Pide la biometría y devuelve el refresh token desbloqueado, o `null` si no hay token / el usuario
   * cancela / la biometría falla.
   */
  unlockRefreshToken(promptTitle?: string): Promise<string | null>;
  /** Elimina el refresh token guardado (logout). */
  clear(): Promise<void>;
}
