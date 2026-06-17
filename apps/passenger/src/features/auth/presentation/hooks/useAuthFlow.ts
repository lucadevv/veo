import type {OtpRequestResult} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {useCallback} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {
  isValidPeruPhone,
  normalizePeruPhone,
} from '../../../../shared/utils/phone';
import {useBiometricGateStore} from '../stores/biometricGateStore';

/** Normaliza el teléfono ingresado al formato que espera el bff (con prefijo 51). */
export function normalizePhone(raw: string): string {
  return normalizePeruPhone(raw);
}

/** Valida el formato de teléfono peruano. */
export function isValidPhone(raw: string): boolean {
  return isValidPeruPhone(raw);
}

/**
 * Orquesta el flujo de login del pasajero (teléfono + OTP) sobre los casos de uso reales
 * (`RequestOtpUseCase`/`VerifyOtpUseCase`) y persiste la sesión en el store seguro tras verificar.
 *
 * SRP: solo coordina mutaciones y persistencia; la UI consume `request`/`verify` y sus estados.
 */
export function useAuthFlow() {
  const requestOtpUseCase = useDependency(TOKENS.requestOtpUseCase);
  const verifyOtpUseCase = useDependency(TOKENS.verifyOtpUseCase);
  const panicSecretProvisioner = useDependency(TOKENS.panicSecretProvisioner);
  const syncPendingConsent = useDependency(TOKENS.syncPendingConsentUseCase);
  const setSession = useSessionStore(state => state.setSession);
  const unlockBiometricGate = useBiometricGateStore(state => state.unlock);

  const requestMutation = useMutation<OtpRequestResult, Error, string>({
    mutationFn: (phone: string) =>
      requestOtpUseCase.execute({
        phone: normalizePhone(phone),
        type: 'PASSENGER',
      }),
  });

  const verifyMutation = useMutation<
    void,
    Error,
    {phone: string; code: string}
  >({
    mutationFn: async ({phone, code}) => {
      const tokens = await verifyOtpUseCase.execute({
        phone: normalizePhone(phone),
        code,
        type: 'PASSENGER',
      });
      setSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: tokens.user,
      });
      // Login fresco: el usuario acaba de autenticarse, no exigir biometría en esta sesión.
      unlockBiometricGate();
      // Drena la cola durable de consentimiento (best-effort): el onboarding capturó la aceptación
      // ANTES del login (sin sesión → quedó Pending). Ahora que hay JWT, el POST puede confirmar.
      void syncPendingConsent.flush();
      // Aprovisiona el secreto HMAC de pánico (best-effort): si falla, se reintenta perezosamente al
      // disparar el pánico. No bloquea el login.
      void panicSecretProvisioner.ensureProvisioned().catch(error => {
        console.warn(
          '[panic] aprovisionamiento del secreto tras login falló:',
          error,
        );
      });
    },
  });

  const requestOtp = useCallback(
    (phone: string) => requestMutation.mutateAsync(phone),
    [requestMutation],
  );

  const verifyOtp = useCallback(
    (phone: string, code: string) => verifyMutation.mutateAsync({phone, code}),
    [verifyMutation],
  );

  return {
    requestOtp,
    verifyOtp,
    requesting: requestMutation.isPending,
    verifying: verifyMutation.isPending,
    requestError: requestMutation.isError,
    verifyError: verifyMutation.isError,
  };
}
