/**
 * Step-up MFA con TOTP (RFC 6238) vía otplib (decisión cliente).
 * Para acciones sensibles del panel admin: acceso a video, gestión RBAC, payouts > S/5K (BR-S07).
 * El secreto TOTP del operador se cifra en reposo (KMS); aquí solo enrolamiento y verificación.
 */
import { authenticator } from 'otplib';

export interface TotpEnrollment {
  secret: string;
  /** URI otpauth:// para generar el QR de enrolamiento */
  otpauthUrl: string;
}

authenticator.options = { window: 1 }; // tolera ±1 ventana (30s) por desfase de reloj

export function enrollTotp(accountEmail: string, issuer = 'VEO Admin'): TotpEnrollment {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(accountEmail, issuer, secret);
  return { secret, otpauthUrl };
}

export function verifyTotp(token: string, secret: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  return authenticator.verify({ token, secret });
}

/** Indica si una verificación MFA sigue "fresca" para autorizar una acción sensible. */
export function isMfaFresh(mfaVerifiedAtEpochSec: number | undefined, maxAgeSec = 300): boolean {
  if (!mfaVerifiedAtEpochSec) return false;
  return Date.now() / 1000 - mfaVerifiedAtEpochSec <= maxAgeSec;
}
