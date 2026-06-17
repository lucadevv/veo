import { ApiError } from '@veo/api-client';
import {
  appleAuth,
  type AppleRequestResponse,
} from '@invertase/react-native-apple-authentication';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { configureGoogleSignin } from '../../infra/googleSignin';
import { useBiometricGateStore } from '../stores/biometricGateStore';

/**
 * Estado clasificado de un error de login social, para mapear el mensaje en la UI.
 * `cancelled` NO es un error real: el usuario abortó el flujo → la UI no muestra Banner.
 */
export type OAuthErrorKind =
  | 'cancelled' // el usuario canceló el sheet nativo → sin Banner
  | 'unavailable' // Play Services / Apple Sign-In no disponible en el dispositivo
  | 'invalidAccount' // backend 401: no pudimos validar la cuenta
  | 'network' // sin conexión / 5xx
  | 'unknown'
  | null;

/** Resultado de un intento de login social: si fue cancelado, la UI no pinta error. */
export interface OAuthAttempt {
  cancelled: boolean;
}

/** Error tipado para señalar que el SDK nativo no está disponible en el dispositivo. */
class OAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthUnavailableError';
  }
}

/** Extrae el código HTTP de un error del cliente (ApiError) o null si no aplica. */
function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/**
 * Orquesta el login social NATIVO (Sign in with Google + Sign in with Apple).
 *
 * El cliente SOLO obtiene el token de identidad del SDK nativo y lo reenvía al backend, que lo
 * verifica soberanamente (JWKS) y emite la sesión. La app NUNCA autoriza: el gate es server-side.
 * Tras el login persiste la sesión IGUAL que el flujo de correo/OTP (`setSession` + desbloqueo del
 * gate biométrico + aprovisionamiento best-effort del secreto de pánico).
 */
export function useOAuthFlow() {
  const loginWithGoogleUseCase = useDependency(TOKENS.loginWithGoogleUseCase);
  const loginWithAppleUseCase = useDependency(TOKENS.loginWithAppleUseCase);
  const panicSecretProvisioner = useDependency(TOKENS.panicSecretProvisioner);
  const syncPendingConsent = useDependency(TOKENS.syncPendingConsentUseCase);
  const setSession = useSessionStore((state) => state.setSession);
  const unlockBiometricGate = useBiometricGateStore((state) => state.unlock);

  /** Persiste la sesión tras el login social (idéntico al flujo de correo/OTP). */
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
      void panicSecretProvisioner.ensureProvisioned().catch((error) => {
        console.warn('[panic] aprovisionamiento del secreto tras login falló:', error);
      });
    },
    [setSession, unlockBiometricGate, panicSecretProvisioner, syncPendingConsent],
  );

  const googleMutation = useMutation<OAuthAttempt, Error, void>({
    mutationFn: async () => {
      configureGoogleSignin();
      // En Android exige Google Play Services antes de abrir el flujo (no-op en iOS).
      if (Platform.OS === 'android') {
        try {
          await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        } catch (error) {
          throw new OAuthUnavailableError(
            isErrorWithCode(error) ? error.code : 'PLAY_SERVICES_NOT_AVAILABLE',
          );
        }
      }

      let idToken: string;
      try {
        const response = await GoogleSignin.signIn();
        if (!isSuccessResponse(response)) {
          // El usuario cerró el sheet nativo: cancelación limpia, sin error.
          return { cancelled: true };
        }
        const token = response.data.idToken;
        if (!token) {
          throw new Error('Google no devolvió idToken');
        }
        idToken = token;
      } catch (error) {
        // SIGN_IN_CANCELLED puede llegar como excepción tipada (no como respuesta `cancelled`).
        if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) {
          return { cancelled: true };
        }
        if (
          isErrorWithCode(error) &&
          error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE
        ) {
          throw new OAuthUnavailableError(error.code);
        }
        throw error;
      }

      const tokens = await loginWithGoogleUseCase.execute({ idToken });
      persistSession(tokens);
      return { cancelled: false };
    },
  });

  const appleMutation = useMutation<OAuthAttempt, Error, void>({
    mutationFn: async () => {
      if (!appleAuth.isSupported) {
        throw new OAuthUnavailableError('APPLE_SIGN_IN_NOT_SUPPORTED');
      }

      let response: AppleRequestResponse;
      try {
        response = await appleAuth.performRequest({
          requestedOperation: appleAuth.Operation.LOGIN,
          requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
        });
      } catch (error) {
        // El usuario canceló el sheet de Apple: cancelación limpia, sin error.
        if (isAppleCancellation(error)) {
          return { cancelled: true };
        }
        throw error;
      }

      const identityToken = response.identityToken;
      if (!identityToken) {
        throw new Error('Apple no devolvió identityToken');
      }

      const tokens = await loginWithAppleUseCase.execute({ identityToken });
      persistSession(tokens);
      return { cancelled: false };
    },
  });

  const signInWithGoogle = useCallback(
    () => googleMutation.mutateAsync(),
    [googleMutation],
  );
  const signInWithApple = useCallback(
    () => appleMutation.mutateAsync(),
    [appleMutation],
  );

  return {
    signInWithGoogle,
    signInWithApple,
    googleLoading: googleMutation.isPending,
    appleLoading: appleMutation.isPending,
    googleError: classifyOAuthError(googleMutation.error),
    appleError: classifyOAuthError(appleMutation.error),
  };
}

/** Reconoce la cancelación del sheet de Apple por su código de error nativo (1001). */
function isAppleCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return code === appleAuth.Error.CANCELED || code === String(appleAuth.Error.CANCELED);
}

/** Clasifica un error de login social → `OAuthErrorKind` para el Banner. */
export function classifyOAuthError(error: unknown): OAuthErrorKind {
  if (!error) return null;
  if (error instanceof OAuthUnavailableError) return 'unavailable';
  const status = statusOf(error);
  if (status === 401 || status === 403) return 'invalidAccount';
  if (status === 0 || (status !== null && status >= 500)) return 'network';
  return 'unknown';
}
