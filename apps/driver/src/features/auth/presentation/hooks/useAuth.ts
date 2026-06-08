import {useMutation} from '@tanstack/react-query';
import {useDi, useRepositories} from '../../../../core/di/useDi';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {RequestOtpUseCase} from '../../domain';
import {VerifyOtpUseCase} from '../../domain';
import {GetProfileUseCase, profileToSessionUser} from '../../../profile/domain';

/**
 * Mutación: solicitar el OTP. El caso de uso valida/normaliza el teléfono.
 */
export function useRequestOtp() {
  const {auth} = useRepositories();
  return useMutation({
    mutationFn: (phone: string) => new RequestOtpUseCase(auth).execute(phone),
  });
}

/**
 * Mutación de login: verifica el OTP, persiste los tokens, resuelve el perfil del conductor
 * (`GET /drivers/me`) y compone la sesión completa. Cubre el hueco del contrato (verify sin `user`).
 *
 * Si el perfil falla, se revierte la sesión (no dejamos tokens sin usuario) y se propaga el error.
 */
export function useLogin() {
  const {auth, profile} = useRepositories();
  const {localAuth} = useDi();
  return useMutation({
    mutationFn: async ({phone, code}: {phone: string; code: string}) => {
      const tokens = await new VerifyOtpUseCase(auth).execute(phone, code);
      // Persistimos tokens primero: el cliente HTTP los lee del store en la siguiente llamada.
      useSessionStore.getState().setTokens(tokens);
      try {
        const driverProfile = await new GetProfileUseCase(profile).execute();
        useSessionStore.getState().setSession({
          tokens,
          user: profileToSessionUser(driverProfile),
        });
        // Guarda el refresh token bajo biometría para el re-login rápido (best-effort).
        if (await localAuth.isAvailable()) {
          await localAuth.saveRefreshToken(tokens.refreshToken).catch(() => undefined);
        }
      } catch (error) {
        useSessionStore.getState().clearSession();
        throw error;
      }
    },
  });
}
