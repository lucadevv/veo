import type {
  AppleOAuth,
  ConsentRecorded,
  CurrentConsent,
  EmailForgot,
  EmailForgotResult,
  EmailLogin,
  EmailRegister,
  EmailRegisterResult,
  EmailResend,
  EmailResendResult,
  EmailReset,
  EmailResetResult,
  EmailVerify,
  GoogleOAuth,
  MobileAuthTokens,
  OtpRequest,
  OtpRequestResult,
  OtpVerify,
  RecordConsentRequest,
} from '@veo/api-client';
import type { AuthRepository } from './authRepository';
import type { ConsentRepository } from './consentRepository';

/**
 * Casos de uso de Auth (patrón de referencia para el resto de features).
 * Dependen de la ABSTRACCIÓN `AuthRepository`, nunca de la implementación concreta.
 *
 * NOTA: la lógica de negocio rica (rate-limit de reenvío, máquinas de estado, etc.) se
 * añade en la oleada de features. Aquí sólo orquestan la llamada al repositorio.
 */

/** Solicita el envío de un OTP al teléfono indicado. */
export class RequestOtpUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: OtpRequest): Promise<OtpRequestResult> {
    return this.repository.requestOtp(input);
  }
}

/** Verifica el OTP y devuelve la sesión (tokens + usuario). */
export class VerifyOtpUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: OtpVerify): Promise<MobileAuthTokens> {
    return this.repository.verifyOtp(input);
  }
}

/* ── Casos de uso · Auth por correo + contraseña (ADR-012) ── */

/** Registra una cuenta por correo y dispara el envío del código (NO emite tokens). */
export class RegisterEmailUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailRegister): Promise<EmailRegisterResult> {
    return this.repository.registerEmail(input);
  }
}

/** Reenvía el código de verificación de correo (endpoint dedicado; anti-enumeración: siempre {sent:true}). */
export class ResendEmailUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailResend): Promise<EmailResendResult> {
    return this.repository.resendEmailCode(input);
  }
}

/** Verifica el correo con el código y devuelve la sesión (tokens + usuario). */
export class VerifyEmailUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailVerify): Promise<MobileAuthTokens> {
    return this.repository.verifyEmail(input);
  }
}

/** Inicia sesión por correo+contraseña y devuelve la sesión (tokens + usuario). */
export class LoginEmailUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailLogin): Promise<MobileAuthTokens> {
    return this.repository.loginEmail(input);
  }
}

/** Solicita el código de restablecimiento de contraseña (respuesta uniforme, anti-enumeración). */
export class ForgotPasswordUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailForgot): Promise<EmailForgotResult> {
    return this.repository.forgotPassword(input);
  }
}

/** Cambia la contraseña con el código de un solo uso. */
export class ResetPasswordUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: EmailReset): Promise<EmailResetResult> {
    return this.repository.resetPassword(input);
  }
}

/* ── Casos de uso · Login social nativo (OAuth) ── */

/** Reenvía el `idToken` de Google al backend y devuelve la sesión (tokens + usuario). */
export class LoginWithGoogleUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: GoogleOAuth): Promise<MobileAuthTokens> {
    return this.repository.loginWithGoogle(input);
  }
}

/** Reenvía el `identityToken` de Apple al backend y devuelve la sesión (tokens + usuario). */
export class LoginWithAppleUseCase {
  constructor(private readonly repository: AuthRepository) {}

  execute(input: AppleOAuth): Promise<MobileAuthTokens> {
    return this.repository.loginWithApple(input);
  }
}

/**
 * Versión vigente de la política de privacidad aceptada en el onboarding (Ley N.° 29733).
 * Es el SELLO legal que viaja con cada aceptación append-only; al publicar una política nueva
 * se actualiza esta constante para que el backend pueda distinguir versiones.
 */
export const CONSENT_POLICY_VERSION = '2026-05-1';

/** Aceptación de consentimientos capturada en el onboarding (sin la `policyVersion`, que la fija el caso de uso). */
export interface ConsentSelection {
  dataProcessing: boolean;
  inCabinCamera: boolean;
  location: boolean;
  /** Comunicaciones de marketing/promociones (opt-in; false en el onboarding, se activa en ajustes). */
  marketing: boolean;
}

/**
 * Registra el consentimiento Ley N.° 29733 en el backend (append-only) en modo BEST-EFFORT:
 * la fuente de verdad es el row servidor, NO el flag local. Reintenta una vez con backoff suave
 * ante fallos transitorios (red/5xx); si tras el reintento sigue fallando, NO lanza: devuelve
 * `null` para que el onboarding no bloquee la navegación (el flag local queda solo como caché).
 */
export class RecordConsentUseCase {
  constructor(
    private readonly repository: ConsentRepository,
    /** Inyectable para tests; en producción usa el default real. */
    private readonly delayMs: (ms: number) => Promise<void> = defaultDelay,
  ) {}

  async execute(selection: ConsentSelection): Promise<ConsentRecorded | null> {
    const request: RecordConsentRequest = {
      dataProcessing: selection.dataProcessing,
      inCabinCamera: selection.inCabinCamera,
      location: selection.location,
      marketing: selection.marketing,
      policyVersion: CONSENT_POLICY_VERSION,
    };
    try {
      return await this.repository.record(request);
    } catch {
      // Reintento suave único: cubre cortes de red puntuales sin bloquear el onboarding.
      try {
        await this.delayMs(800);
        return await this.repository.record(request);
      } catch {
        return null;
      }
    }
  }
}

/** Lee el consentimiento VIGENTE del pasajero (el más reciente; `null` si nunca registró). */
export class GetConsentUseCase {
  constructor(private readonly repository: ConsentRepository) {}

  execute(): Promise<CurrentConsent> {
    return this.repository.getCurrent();
  }
}

/** Espera no bloqueante por defecto (reintento suave). */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
