import { useMutation } from '@tanstack/react-query';
import { useDi, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { RequestOtpUseCase } from '../../domain';
import { VerifyOtpUseCase } from '../../domain';

/**
 * Mutación: solicitar el OTP. El caso de uso valida/normaliza el teléfono.
 */
export function useRequestOtp() {
  const { auth } = useRepositories();
  return useMutation({
    mutationFn: (phone: string) => new RequestOtpUseCase(auth).execute(phone),
  });
}

/**
 * Mutación de login: verifica el OTP y persiste los tokens, dejando la sesión en `authenticated`.
 *
 * IMPORTANTE: el login NO resuelve el perfil del conductor (`GET /drivers/me`). Un conductor nuevo
 * todavía no tiene perfil y el backend responde 404 — eso NO es un error de login, es la señal de
 * "andá al wizard de alta". Quien resuelve el perfil (y por ende el estado del alta + el `user` de
 * sesión) es `useRegistrationGate`, que corre cuando la sesión ya es `authenticated` y mapea el 404
 * a `forceWizard()`. Si fetcháramos el perfil acá y revirtiéramos la sesión ante el 404, el gate
 * nunca correría y el conductor nuevo vería un banner de error en vez del wizard.
 */
export function useLogin() {
  const { auth } = useRepositories();
  const { localAuth } = useDi();
  return useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) => {
      const tokens = await new VerifyOtpUseCase(auth).execute(phone, code);
      // Solo tokens + estado autenticado: el perfil/usuario lo compone `useRegistrationGate`.
      useSessionStore.getState().setTokens(tokens);
      useSessionStore.getState().setAuthenticated();
      // Guarda el refresh token bajo biometría para el re-login rápido (best-effort).
      if (await localAuth.isAvailable()) {
        await localAuth.saveRefreshToken(tokens.refreshToken).catch(() => undefined);
      }
    },
  });
}
