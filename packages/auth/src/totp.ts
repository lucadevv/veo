/**
 * Step-up MFA con TOTP (RFC 6238) vía otplib (decisión cliente).
 * Para acciones sensibles del panel admin: acceso a video, gestión RBAC, payouts > S/5K (BR-S07).
 * El secreto TOTP del operador se cifra en reposo (KMS); aquí solo enrolamiento y verificación.
 *
 * RELOJ INYECTABLE: `verifyTotp` / `generateTotp` / `isMfaFresh` aceptan `nowMs` (milisegundos desde
 * epoch). El default `= Date.now()` es SOLO un fallback ergonómico para callers triviales; la INTENCIÓN
 * de diseño es que el servicio inyecte el puerto `Clock` (@veo/utils) y pase `clock.now()` explícito —
 * así el TOTP es determinista y testeable a cualquier instante (incl. fechas futuras), sin tocar el
 * reloj real ni mockear `Date`.
 *
 * Gotcha otplib (estado compartido): el `authenticator` exportado es un singleton con opciones globales.
 * Para fijar el `epoch` por-llamada usamos `authenticator.clone({ epoch })`, que devuelve una INSTANCIA
 * NUEVA fusionando las opciones actuales (window:1 + keyEncoder/keyDecoder Base32 del preset) con el
 * override — NUNCA mutamos `authenticator.options`, que afectaría a todos los callers concurrentes.
 * (Ojo: `.create()` SÍ resetea el keyEncoder/keyDecoder Base32 y rompería los secretos — usar `.clone()`.)
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

/**
 * Verifica un token TOTP contra el secreto en el instante `nowMs` (ms desde epoch). El servicio
 * inyecta `clock.now()`; el default `Date.now()` es solo fallback. Mantiene `window: 1` (±30s).
 */
export function verifyTotp(token: string, secret: string, nowMs: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  // clone() preserva window + encoders Base32 del preset y solo sobreescribe el epoch (sin mutar el global).
  return authenticator.clone({ epoch: nowMs }).verify({ token, secret });
}

/**
 * Genera el token TOTP del secreto en el instante `nowMs` (ms desde epoch). Útil para tests
 * deterministas (generar en T y verificar en T) y para clientes que muestren el código.
 */
export function generateTotp(secret: string, nowMs: number = Date.now()): string {
  return authenticator.clone({ epoch: nowMs }).generate(secret);
}

/**
 * Indica si una verificación MFA sigue "fresca" para autorizar una acción sensible.
 * `nowMs` (ms desde epoch) lo inyecta el servicio vía `clock.now()`; el default es solo fallback.
 */
export function isMfaFresh(
  mfaVerifiedAtEpochSec: number | undefined,
  maxAgeSec = 300,
  nowMs: number = Date.now(),
): boolean {
  if (!mfaVerifiedAtEpochSec) return false;
  return nowMs / 1000 - mfaVerifiedAtEpochSec <= maxAgeSec;
}
