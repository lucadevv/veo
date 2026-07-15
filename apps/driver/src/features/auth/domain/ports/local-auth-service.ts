/**
 * Puerto de autenticación LOCAL del dispositivo (Face ID / huella).
 *
 * Permite un re-login rápido y seguro: el refresh token se guarda en el almacén seguro del SO
 * (Keychain iOS / Keystore Android) protegido por biometría. Al expirar la sesión, el conductor
 * desbloquea el token con su rostro/huella sin reingresar el OTP.
 */
/**
 * Desenlace TIPADO del desbloqueo biométrico (DRIFT-1) — reemplaza el `string | null` que colapsaba
 * cancelación y FALLO REAL en el mismo `null` (por eso un fallo de Face ID no mostraba banner). Ahora la capa
 * de presentación distingue: `cancelled`/`empty` → silencioso (cae a OTP), `failed` → banner de error.
 *  - `ok`        → biometría OK, `token` es el refresh desbloqueado.
 *  - `empty`     → no hay token guardado (nada que desbloquear).
 *  - `cancelled` → el usuario canceló el prompt (no es un error a mostrar).
 *  - `failed`    → fallo biométrico REAL (o ambiguo): se muestra el banner de error.
 */
export type UnlockRefreshTokenOutcome =
  | { status: 'ok'; token: string }
  | { status: 'empty' }
  | { status: 'cancelled' }
  | { status: 'failed'; error?: unknown };

export interface LocalAuthService {
  /** true si el dispositivo tiene biometría disponible y configurada. */
  isAvailable(): Promise<boolean>;
  /** Persiste el refresh token bajo protección biométrica. */
  saveRefreshToken(token: string): Promise<void>;
  /** true si hay un refresh token guardado para este dispositivo. */
  hasStoredToken(): Promise<boolean>;
  /**
   * Pide la biometría y devuelve el desenlace TIPADO: token (ok), sin-token (empty), cancelación del usuario
   * (cancelled) o fallo biométrico real (failed). La presentación decide banner vs silencio con `status`.
   */
  unlockRefreshToken(promptTitle?: string): Promise<UnlockRefreshTokenOutcome>;
  /** Elimina el refresh token guardado (logout). */
  clear(): Promise<void>;
}
