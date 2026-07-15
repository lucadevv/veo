import { useCallback, useEffect, useState } from 'react';
import { useDi, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { refreshBiometricSession } from '../../data';
import { GetProfileUseCase, profileToSessionUser } from '../../../profile/domain';

interface BiometricReloginState {
  /** true si hay biometría disponible y un refresh token guardado (se puede ofrecer re-login). */
  available: boolean;
  isPending: boolean;
  error: unknown;
  /** Lanza la biometría, desbloquea el refresh token y restablece la sesión. */
  relogin(): Promise<void>;
}

/**
 * Re-login biométrico: desbloquea el refresh token guardado en Keychain/Keystore con Face ID/huella,
 * refresca los tokens en el `driver-bff` y restablece la sesión sin reingresar el OTP.
 *
 * No es un mock: usa el almacén seguro real y el endpoint `/auth/refresh` real. Si la biometría se
 * cancela o el refresh falla, deja al conductor en el flujo OTP normal.
 */
export function useBiometricRelogin(): BiometricReloginState {
  const { localAuth } = useDi();
  const { profile } = useRepositories();
  const [available, setAvailable] = useState(false);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const supported = await localAuth.isAvailable();
      const stored = supported && (await localAuth.hasStoredToken());
      if (active) {
        setAvailable(stored);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [localAuth]);

  const relogin = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      const unlock = await localAuth.unlockRefreshToken();
      // DRIFT-1: cancelación o sin-token → silencioso (el conductor cae al OTP, sin banner). Fallo biométrico
      // REAL → error visible (banner): antes se colapsaba todo a null y un fallo genuino no avisaba.
      if (unlock.status === 'cancelled' || unlock.status === 'empty') {
        return;
      }
      if (unlock.status === 'failed') {
        throw new Error(
          'No pudimos verificar tu identidad. Inténtalo de nuevo o ingresa con tu número.',
        );
      }
      const refreshToken = unlock.token;

      // La llamada remota (fetch + timeout + validación de schema) vive en la capa `data`
      // (`refreshBiometricSession`), no en presentation (regla clean-remote-calls). Devuelve los tokens
      // ya rotados o lanza (BFF no-OK / respuesta inválida / abort por timeout) → cae al catch (banner).
      const tokens = await refreshBiometricSession(refreshToken);
      useSessionStore.getState().setTokens(tokens);
      // PERSISTIR EL KEYCHAIN PRIMERO (A3), ANTES del fetch FALIBLE del perfil: el server YA rotó el jti al
      // responder OK, así que el Keychain debe quedar con el jti NUEVO independientemente de si el perfil carga.
      // Si esto fuera después del perfil (como antes) y el perfil throweara, el Keychain conservaría el jti VIEJO
      // ya rotado → el próximo relogin lo presenta → reuse-detection mata la familia (relogin brickeado).
      try {
        await localAuth.saveRefreshToken(tokens.refreshToken);
      } catch (persistError) {
        // Best-effort + observable (no silencioso): si el Keychain no guarda, el próximo relogin cae a OTP.
        console.warn(
          '[relogin] no se pudo persistir el refresh token en el Keychain:',
          persistError,
        );
      }
      const driverProfile = await new GetProfileUseCase(profile).execute();
      useSessionStore.getState().setSession({ tokens, user: profileToSessionUser(driverProfile) });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }, [localAuth, profile]);

  return { available, isPending, error, relogin };
}
