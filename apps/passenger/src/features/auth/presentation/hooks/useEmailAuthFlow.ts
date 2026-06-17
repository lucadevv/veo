import type {
  EmailForgotResult,
  EmailRegisterResult,
  EmailResendResult,
  EmailResetResult,
} from '@veo/api-client';
import {ApiError} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {useCallback} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {useBiometricGateStore} from '../stores/biometricGateStore';

/** Mínimo de contraseña (ADR-012 §4). El backend además rechaza contraseñas triviales (400). */
export const EMAIL_PASSWORD_MIN = 12;

/** Regex de correo de borde (la validación autoritativa la hace el backend). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valida el formato de correo para habilitar/deshabilitar los CTA. */
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

/** Valida la longitud mínima de contraseña (cliente). El backend valida lo demás. */
export function isValidPassword(raw: string): boolean {
  return raw.length >= EMAIL_PASSWORD_MIN;
}

/** Estado clasificado de un error de auth por correo, para mapear el mensaje en la UI. */
export type EmailAuthErrorKind =
  | 'invalidCredentials' // 401
  | 'notVerified' // 403
  | 'alreadyExists' // 409
  | 'weakPassword' // 400
  | 'invalidCode' // 401 en verify/reset (código incorrecto/vencido)
  | 'network' // sin conexión / 5xx
  | 'unknown'
  | null;

/** Extrae el código HTTP de un error del cliente (ApiError) o null si no aplica. */
function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/**
 * Orquesta el flujo de auth por correo+contraseña (ADR-012): register → verify, login, forgot → reset.
 * Mismo patrón que `useAuthFlow` (OTP): cada paso expone `isPending` y un clasificador de error para
 * que la UI pinte el Banner adecuado. Tras verify/login persiste la sesión IGUAL que el OTP
 * (`setSession` + `unlockBiometricGate` + aprovisionamiento best-effort del secreto de pánico).
 */
export function useEmailAuthFlow() {
  const registerEmailUseCase = useDependency(TOKENS.registerEmailUseCase);
  const resendEmailUseCase = useDependency(TOKENS.resendEmailUseCase);
  const verifyEmailUseCase = useDependency(TOKENS.verifyEmailUseCase);
  const loginEmailUseCase = useDependency(TOKENS.loginEmailUseCase);
  const forgotPasswordUseCase = useDependency(TOKENS.forgotPasswordUseCase);
  const resetPasswordUseCase = useDependency(TOKENS.resetPasswordUseCase);
  const panicSecretProvisioner = useDependency(TOKENS.panicSecretProvisioner);
  const syncPendingConsent = useDependency(TOKENS.syncPendingConsentUseCase);
  const setSession = useSessionStore(state => state.setSession);
  const unlockBiometricGate = useBiometricGateStore(state => state.unlock);

  /** Persiste la sesión tras verify/login (idéntico al flujo OTP). */
  const persistSession = useCallback(
    (tokens: {
      accessToken: string;
      refreshToken: string;
      user: Parameters<typeof setSession>[0]['user'];
    }) => {
      setSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: tokens.user,
      });
      // Login fresco: no exigir biometría en esta sesión.
      unlockBiometricGate();
      // Drena la cola durable de consentimiento (best-effort): el onboarding la encoló antes del login.
      void syncPendingConsent.flush();
      // Aprovisiona el secreto HMAC de pánico (best-effort): si falla, se reintenta al disparar.
      void panicSecretProvisioner.ensureProvisioned().catch(error => {
        console.warn(
          '[panic] aprovisionamiento del secreto tras login falló:',
          error,
        );
      });
    },
    [
      setSession,
      unlockBiometricGate,
      panicSecretProvisioner,
      syncPendingConsent,
    ],
  );

  const registerMutation = useMutation<
    EmailRegisterResult,
    Error,
    {email: string; password: string; name?: string}
  >({
    mutationFn: ({email, password, name}) =>
      registerEmailUseCase.execute({
        email: email.trim().toLowerCase(),
        password,
        name: name?.trim() ? name.trim() : undefined,
        type: 'PASSENGER',
      }),
  });

  const resendMutation = useMutation<EmailResendResult, Error, string>({
    mutationFn: (email: string) =>
      resendEmailUseCase.execute({email: email.trim().toLowerCase()}),
  });

  const verifyMutation = useMutation<
    void,
    Error,
    {email: string; code: string}
  >({
    mutationFn: async ({email, code}) => {
      const tokens = await verifyEmailUseCase.execute({
        email: email.trim().toLowerCase(),
        code,
      });
      persistSession(tokens);
    },
  });

  const loginMutation = useMutation<
    void,
    Error,
    {email: string; password: string}
  >({
    mutationFn: async ({email, password}) => {
      const tokens = await loginEmailUseCase.execute({
        email: email.trim().toLowerCase(),
        password,
      });
      persistSession(tokens);
    },
  });

  const forgotMutation = useMutation<EmailForgotResult, Error, string>({
    mutationFn: (email: string) =>
      forgotPasswordUseCase.execute({email: email.trim().toLowerCase()}),
  });

  const resetMutation = useMutation<
    EmailResetResult,
    Error,
    {email: string; code: string; newPassword: string}
  >({
    mutationFn: ({email, code, newPassword}) =>
      resetPasswordUseCase.execute({
        email: email.trim().toLowerCase(),
        code,
        newPassword,
      }),
  });

  const registerEmail = useCallback(
    (email: string, password: string, name?: string) =>
      registerMutation.mutateAsync({email, password, name}),
    [registerMutation],
  );
  const resendEmail = useCallback(
    (email: string) => resendMutation.mutateAsync(email),
    [resendMutation],
  );
  const verifyEmail = useCallback(
    (email: string, code: string) => verifyMutation.mutateAsync({email, code}),
    [verifyMutation],
  );
  const loginEmail = useCallback(
    (email: string, password: string) =>
      loginMutation.mutateAsync({email, password}),
    [loginMutation],
  );
  const forgotPassword = useCallback(
    (email: string) => forgotMutation.mutateAsync(email),
    [forgotMutation],
  );
  const resetPassword = useCallback(
    (email: string, code: string, newPassword: string) =>
      resetMutation.mutateAsync({email, code, newPassword}),
    [resetMutation],
  );

  return {
    registerEmail,
    resendEmail,
    verifyEmail,
    loginEmail,
    forgotPassword,
    resetPassword,
    // Estados de carga por paso.
    registering: registerMutation.isPending,
    resending: resendMutation.isPending,
    verifying: verifyMutation.isPending,
    loggingIn: loginMutation.isPending,
    forgetting: forgotMutation.isPending,
    resetting: resetMutation.isPending,
    // Clasificación de error por paso (para el Banner danger).
    registerError: classifyRegisterError(registerMutation.error),
    resendError: classifyNetworkError(resendMutation.error),
    verifyError: classifyCodeError(verifyMutation.error),
    loginError: classifyLoginError(loginMutation.error),
    forgotError: classifyNetworkError(forgotMutation.error),
    resetError: classifyResetError(resetMutation.error),
  };
}

/* ── Clasificadores de error → EmailAuthErrorKind ── */

function classifyRegisterError(error: unknown): EmailAuthErrorKind {
  if (!error) return null;
  const status = statusOf(error);
  if (status === 409) return 'alreadyExists';
  if (status === 400) return 'weakPassword';
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}

function classifyLoginError(error: unknown): EmailAuthErrorKind {
  if (!error) return null;
  const status = statusOf(error);
  if (status === 403) return 'notVerified';
  if (status === 401) return 'invalidCredentials';
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}

function classifyCodeError(error: unknown): EmailAuthErrorKind {
  if (!error) return null;
  const status = statusOf(error);
  if (status === 401) return 'invalidCode';
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}

function classifyResetError(error: unknown): EmailAuthErrorKind {
  if (!error) return null;
  const status = statusOf(error);
  if (status === 400) return 'weakPassword';
  if (status === 401) return 'invalidCode';
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}

function classifyNetworkError(error: unknown): EmailAuthErrorKind {
  if (!error) return null;
  const status = statusOf(error);
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}
